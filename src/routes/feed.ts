import express, { Request, Response } from 'express';
import multer from 'multer';
import mongoose from 'mongoose';
import { body, param, validationResult } from 'express-validator';
import { authenticateToken } from '../middleware/auth';
import { Post } from '../models/Post';
import { PostComment } from '../models/PostComment';
import { Friendship } from '../models/Friendship';
import { Notification } from '../models/Notification';
import { User } from '../models/User';
import { ChatMessage } from '../models/ChatMessage';
import { isSupportedMediaType, mediaKindFromMime, mediaStorage } from '../utils/mediaStorage';
import { broadcastSse } from '../utils/sse';

const router = express.Router();

/** Los vídeos cortos de una serie caben de sobra en 80 MB; se lee en memoria y se vuelca al almacén. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 80 * 1024 * 1024 },
});

const STORY_LIFETIME_MS = 24 * 60 * 60 * 1000;

function toObjectId(id: string): mongoose.Types.ObjectId {
  return new mongoose.Types.ObjectId(id);
}

/** Ids de amigos aceptados más el propio usuario: es el alcance de todo el feed. */
async function circleIds(userId: string): Promise<mongoose.Types.ObjectId[]> {
  const rows = await Friendship.find({
    status: 'accepted',
    $or: [{ requester: userId }, { recipient: userId }],
  })
    .select('requester recipient')
    .lean();
  const ids = new Set<string>([String(userId)]);
  rows.forEach((r: any) => {
    ids.add(String(r.requester));
    ids.add(String(r.recipient));
  });
  return Array.from(ids).map(toObjectId);
}

async function areFriends(a: string, b: string): Promise<boolean> {
  if (String(a) === String(b)) return true;
  const found = await Friendship.findOne({
    status: 'accepted',
    $or: [
      { requester: a, recipient: b },
      { requester: b, recipient: a },
    ],
  }).lean();
  return !!found;
}

function authorOf(user: any) {
  return {
    id: String(user?._id ?? user?.id ?? ''),
    name: user?.name || 'Usuario',
    avatar: user?.avatar || null,
  };
}

function serializePost(post: any, viewerId: string) {
  const likes: any[] = post.likes ?? [];
  const mine = String(post.userId?._id ?? post.userId) === String(viewerId);
  const views: any[] = post.views ?? [];
  return {
    id: String(post._id),
    kind: post.kind,
    mediaType: post.mediaType,
    mediaKey: post.mediaKey,
    caption: post.caption ?? '',
    likeCount: likes.length,
    likedByMe: likes.some((l: any) => String(l?._id ?? l) === String(viewerId)),
    viewedByMe: views.some((v: any) => String(v?._id ?? v) === String(viewerId)),
    commentCount: post.commentCount ?? 0,
    createdAt: post.createdAt,
    expiresAt: post.expiresAt ?? null,
    author: authorOf(post.userId),
    mine,
    // Quién ha visto o dado like solo se le enseña a su autor.
    ...(mine && post.kind === 'story'
      ? {
          viewCount: views.length,
          viewers: views.filter((v: any) => v?.name).map(authorOf),
          likers: likes.filter((l: any) => l?.name).map(authorOf),
        }
      : {}),
  };
}

/** Publicar foto o vídeo. `kind=story` caduca sola a las 24 h. */
router.post(
  '/posts',
  authenticateToken,
  upload.single('file'),
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user.userId;
      const file = (req as any).file as { buffer: Buffer; mimetype: string } | undefined;
      if (!file) return res.status(400).json({ error: 'Falta el archivo' });
      if (!isSupportedMediaType(file.mimetype)) {
        return res.status(415).json({ error: 'Formato no admitido: usa JPG, PNG, WEBP, GIF, MP4, MOV o WEBM' });
      }

      const kind = String(req.body.kind || 'story') === 'post' ? 'post' : 'story';
      const caption = String(req.body.caption || '').trim().slice(0, 2200);
      const stored = await mediaStorage().save(file.buffer, file.mimetype);

      const post = await Post.create({
        userId: toObjectId(userId),
        kind,
        mediaType: mediaKindFromMime(file.mimetype),
        mediaKey: stored.key,
        mimeType: stored.mimeType,
        caption,
        likes: [],
        commentCount: 0,
        ...(kind === 'story' ? { expiresAt: new Date(Date.now() + STORY_LIFETIME_MS) } : {}),
      });

      const author = await User.findById(userId).select('name avatar').lean();
      res.status(201).json(serializePost({ ...post.toObject(), userId: author }, userId));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

/** Publicaciones propias y de amigos, de la más nueva a la más vieja. */
router.get('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const limit = Math.min(30, Math.max(1, parseInt(String(req.query.limit || '15'), 10) || 15));
    const before = req.query.before ? new Date(String(req.query.before)) : null;

    const posts = await Post.find({
      userId: { $in: await circleIds(userId) },
      kind: 'post',
      ...(before && !Number.isNaN(before.getTime()) ? { createdAt: { $lt: before } } : {}),
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('userId', 'name avatar')
      .lean();

    res.json({
      posts: posts.map(p => serializePost(p, userId)),
      nextCursor: posts.length === limit ? posts[posts.length - 1].createdAt : null,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** Historias vivas agrupadas por autor, con el usuario primero. */
router.get('/stories', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const stories = await Post.find({
      userId: { $in: await circleIds(userId) },
      kind: 'story',
      expiresAt: { $gt: new Date() },
    })
      .sort({ createdAt: 1 })
      .populate('userId', 'name avatar')
      .populate('views', 'name avatar')
      .populate('likes', 'name avatar')
      .lean();

    const byAuthor = new Map<string, { author: ReturnType<typeof authorOf>; items: any[] }>();
    stories.forEach(s => {
      const author = authorOf(s.userId);
      if (!byAuthor.has(author.id)) byAuthor.set(author.id, { author, items: [] });
      byAuthor.get(author.id)!.items.push(serializePost(s, userId));
    });

    const groups = Array.from(byAuthor.values()).sort((a, b) =>
      a.author.id === String(userId) ? -1 : b.author.id === String(userId) ? 1 : 0
    );
    res.json({ groups });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** Publicaciones de un usuario concreto (solo amigos o uno mismo). */
router.get('/users/:userId/posts', authenticateToken, async (req: Request, res: Response) => {
  try {
    const viewerId = (req as any).user.userId;
    const target = req.params.userId;
    if (!mongoose.isValidObjectId(target)) return res.status(400).json({ error: 'Usuario inválido' });
    if (!(await areFriends(viewerId, target))) {
      return res.status(403).json({ error: 'Solo puedes ver las publicaciones de tus amigos' });
    }

    const posts = await Post.find({ userId: target, kind: 'post' })
      .sort({ createdAt: -1 })
      .limit(60)
      .populate('userId', 'name avatar')
      .lean();
    res.json({ posts: posts.map(p => serializePost(p, viewerId)) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** Marcar una historia como vista: su autor verá quién ha pasado por ella. */
router.post('/posts/:id/view', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const post = await Post.findById(req.params.id).select('userId kind').lean();
    if (!post) return res.status(404).json({ error: 'Publicación no encontrada' });
    if (String(post.userId) === String(userId)) return res.json({ ok: true });
    if (!(await areFriends(userId, String(post.userId)))) {
      return res.status(403).json({ error: 'No puedes ver esta historia' });
    }

    await Post.updateOne({ _id: post._id }, { $addToSet: { views: toObjectId(userId) } });
    res.json({ ok: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** Me gusta: el mismo endpoint quita y pone. */
router.post('/posts/:id/like', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ error: 'Publicación no encontrada' });
    if (!(await areFriends(userId, String(post.userId)))) {
      return res.status(403).json({ error: 'No puedes interactuar con esta publicación' });
    }

    const already = post.likes.some(l => String(l) === String(userId));
    post.likes = already
      ? post.likes.filter(l => String(l) !== String(userId))
      : [...post.likes, toObjectId(userId)];
    await post.save();

    if (!already && String(post.userId) !== String(userId)) {
      const me = await User.findById(userId).select('name').lean();
      const story = post.kind === 'story';
      await Notification.create({
        userId: post.userId,
        type: 'post_like',
        title: 'Nuevo me gusta',
        message: story
          ? `A ${me?.name || 'alguien'} le gusta tu historia`
          : `A ${me?.name || 'alguien'} le gusta tu publicación`,
        relatedUserId: toObjectId(userId),
        relatedData: { postId: String(post._id) },
      }).catch(() => {});
      broadcastSse([String(post.userId)], 'social_update');
    }

    res.json({ likeCount: post.likes.length, likedByMe: !already });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/posts/:id/comments', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const post = await Post.findById(req.params.id).select('userId').lean();
    if (!post) return res.status(404).json({ error: 'Publicación no encontrada' });
    if (!(await areFriends(userId, String(post.userId)))) {
      return res.status(403).json({ error: 'No puedes ver estos comentarios' });
    }

    const comments = await PostComment.find({ postId: req.params.id })
      .sort({ createdAt: 1 })
      .populate('userId', 'name avatar')
      .lean();

    res.json({
      comments: comments.map((c: any) => ({
        id: String(c._id),
        text: c.text,
        createdAt: c.createdAt,
        author: authorOf(c.userId),
        mine: String(c.userId?._id ?? c.userId) === String(userId),
      })),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post(
  '/posts/:id/comments',
  authenticateToken,
  [body('text').trim().notEmpty().withMessage('El comentario está vacío')],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const userId = (req as any).user.userId;
      const post = await Post.findById(req.params.id);
      if (!post) return res.status(404).json({ error: 'Publicación no encontrada' });
      if (!(await areFriends(userId, String(post.userId)))) {
        return res.status(403).json({ error: 'No puedes comentar esta publicación' });
      }

      const created = await PostComment.create({
        postId: post._id,
        userId: toObjectId(userId),
        text: String(req.body.text).trim().slice(0, 1000),
      });
      post.commentCount = (post.commentCount ?? 0) + 1;
      await post.save();

      const me = await User.findById(userId).select('name avatar').lean();
      const story = post.kind === 'story';
      const snippet = story
        ? `${me?.name || 'Alguien'} ha respondido a tu historia`
        : `${me?.name || 'Alguien'}: ${created.text.slice(0, 80)}`;
      const ownerId = String(post.userId);
      if (ownerId !== String(userId)) {
        await Notification.create({
          userId: post.userId,
          type: 'post_comment',
          title: story ? 'Historia' : 'Nuevo comentario',
          message: snippet,
          relatedUserId: toObjectId(userId),
          relatedData: { postId: String(post._id) },
        }).catch(() => {});
        if (story) {
          try {
            const { sendPushToUser } = await import('../utils/push');
            await sendPushToUser(ownerId, 'Historia', snippet, {
              type: 'post_comment',
              screen: 'social',
              tab: 'chat',
              peerId: String(userId),
            });
          } catch (e) {
            console.error('[PUSH] Error comentario de historia:', e);
          }
        }
      }

      if (story && ownerId !== String(userId)) {
        const chat = await ChatMessage.create({
          from: toObjectId(userId),
          to: post.userId,
          text: created.text,
          storyReply: {
            postId: String(post._id),
            mediaKey: post.mediaKey,
            mediaType: post.mediaType,
            caption: post.caption || '',
          },
        });
        const reply = {
          postId: String(post._id),
          mediaKey: post.mediaKey,
          mediaType: post.mediaType,
          caption: post.caption || '',
        };
        const base = {
          id: String(chat._id),
          text: chat.text,
          storyReply: reply,
          mediaKey: null,
          mediaType: null,
          createdAt: chat.createdAt.toISOString(),
          from: { id: userId, name: me?.name || 'Atleta', avatar: me?.avatar || null },
        };
        broadcastSse([ownerId], 'chat_message', {
          message: { ...base, mine: false, author: base.from },
          peerId: userId,
        });
        broadcastSse([userId], 'chat_message', {
          message: { ...base, mine: true, author: base.from },
          peerId: ownerId,
        });
      }
      const otherCommenters = await PostComment.distinct('userId', {
        postId: post._id,
        userId: { $nin: [toObjectId(userId), post.userId] },
      });
      if (otherCommenters.length > 0) {
        await Notification.insertMany(
          otherCommenters.map(uid => ({
            userId: uid,
            type: 'post_comment_reply' as const,
            title: 'Respuesta a tu comentario',
            message: `${me?.name || 'Alguien'} ha respondido: ${created.text.slice(0, 80)}`,
            relatedUserId: toObjectId(userId),
            relatedData: { postId: String(post._id) },
          }))
        ).catch(() => {});
      }
      const notifyIds = [String(post.userId), ...otherCommenters.map(id => String(id))].filter(id => id !== String(userId));
      if (notifyIds.length) broadcastSse(notifyIds, 'social_update');

      res.status(201).json({
        id: String(created._id),
        text: created.text,
        createdAt: created.createdAt,
        author: authorOf({ _id: userId, ...me }),
        mine: true,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

router.delete('/comments/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const comment = await PostComment.findById(req.params.id);
    if (!comment) return res.status(404).json({ error: 'Comentario no encontrado' });
    const post = await Post.findById(comment.postId).select('userId commentCount');
    const isAuthor = String(comment.userId) === String(userId);
    const isPostOwner = post && String(post.userId) === String(userId);
    if (!isAuthor && !isPostOwner) return res.status(403).json({ error: 'No puedes borrar este comentario' });

    await comment.deleteOne();
    if (post) {
      post.commentCount = Math.max(0, (post.commentCount ?? 1) - 1);
      await post.save();
    }
    res.json({ message: 'Comentario eliminado' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete(
  '/posts/:id',
  authenticateToken,
  [param('id').isMongoId().withMessage('Publicación inválida')],
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user.userId;
      const post = await Post.findOne({ _id: req.params.id, userId });
      if (!post) return res.status(404).json({ error: 'Publicación no encontrada' });

      await mediaStorage().remove(post.mediaKey);
      await PostComment.deleteMany({ postId: post._id });
      await post.deleteOne();
      res.json({ message: 'Publicación eliminada' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

export default router;
