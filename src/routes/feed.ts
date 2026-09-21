import express, { Request, Response } from 'express';
import multer from 'multer';
import mongoose from 'mongoose';
import { body, param, validationResult } from 'express-validator';
import { authenticateToken } from '../middleware/auth';
import { Post } from '../models/Post';
import { PostComment } from '../models/PostComment';
import { Notification } from '../models/Notification';
import { User } from '../models/User';
import { ChatMessage } from '../models/ChatMessage';
import { isSupportedMediaType, mediaKindFromMime, mediaStorage } from '../utils/mediaStorage';
import { canSeeContent, circleIds } from '../utils/friendship';
import { blockBetween, blockedIdsFor, canSeeCloseAudience } from '../utils/privacy';
import { broadcastSse } from '../utils/sse';
import { chatIsOpen, ensurePendingChatRequest } from '../utils/chatAccess';
import { publicListAvatar } from '../utils/avatarMedia';

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

function authorOf(user: any) {
  return {
    id: String(user?._id ?? user?.id ?? ''),
    name: user?.name || 'Usuario',
    avatar: publicListAvatar(user?.avatar, String(user?._id ?? user?.id ?? '')) || null,
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
    // Quién ha visto o dado like solo se le enseña a su autor (tú no sales en tu lista).
    ...(mine && post.kind === 'story'
      ? {
          viewCount: views.filter((v: any) => String(v?._id ?? v) !== String(viewerId)).length,
          viewers: views
            .filter((v: any) => v?.name && String(v?._id ?? v) !== String(viewerId))
            .map(authorOf),
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
      const audience = String(req.body.audience || 'all') === 'close' ? 'close' : 'all';
      const stored = await mediaStorage().save(file.buffer, file.mimetype);

      const post = await Post.create({
        userId: toObjectId(userId),
        kind,
        mediaType: mediaKindFromMime(file.mimetype),
        mediaKey: stored.key,
        mimeType: stored.mimeType,
        caption,
        audience,
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

    const hidden = await blockedIdsFor(String(userId));
    const authorIds = [...new Set(stories.map(s => String((s.userId as any)?._id ?? s.userId)))];
    const authors = authorIds.length
      ? await User.find({ _id: { $in: authorIds } }).select('name avatar closeFriendIds').lean()
      : [];
    const authorById = new Map(authors.map(u => [String(u._id), u]));
    const visibleStories = stories.filter(s => {
      const uid = String((s.userId as any)?._id ?? s.userId);
      if (hidden.has(uid) && uid !== String(userId)) return false;
      const close = new Set((authorById.get(uid)?.closeFriendIds || []).map((id: unknown) => String(id)));
      return canSeeCloseAudience(String(userId), uid, (s as any).audience, close);
    });

    const byAuthor = new Map<string, { author: ReturnType<typeof authorOf>; items: any[] }>();
    visibleStories.forEach(s => {
      const uid = String((s.userId as any)?._id ?? s.userId);
      const author = authorOf(authorById.get(uid) || s.userId);
      if (!byAuthor.has(author.id)) byAuthor.set(author.id, { author, items: [] });
      byAuthor.get(author.id)!.items.push(serializePost(s, userId));
    });

    const groups = Array.from(byAuthor.values()).sort((a, b) => {
      if (a.author.id === String(userId)) return -1;
      if (b.author.id === String(userId)) return 1;
      const aFresh = a.items.some(i => !i.viewedByMe);
      const bFresh = b.items.some(i => !i.viewedByMe);
      if (aFresh !== bFresh) return aFresh ? -1 : 1;
      return 0;
    });
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
    const blocked = await blockBetween(String(viewerId), String(target));
    if (blocked === 'them') {
      return res.status(403).json({ error: 'Te ha bloqueado', blocked: 'them' });
    }
    if (blocked === 'you') {
      return res.status(403).json({ error: 'Has bloqueado a esta persona', blocked: 'you' });
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
    if (String(post.userId) === String(userId)) {
      await Post.updateOne({ _id: post._id }, { $addToSet: { views: toObjectId(userId) } });
      return res.json({ ok: true });
    }
    if (!(await canSeeContent(userId, String(post.userId)))) {
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
    if (!(await canSeeContent(userId, String(post.userId)))) {
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
      const likeTitle = 'Nuevo me gusta';
      const likeMessage = story
        ? `A ${me?.name || 'alguien'} le gusta tu historia`
        : `A ${me?.name || 'alguien'} le gusta tu publicación`;
      const likeRecent = await Notification.findOne({
        userId: post.userId,
        type: 'post_like',
        relatedUserId: toObjectId(userId),
        'relatedData.postId': String(post._id),
        read: false,
        createdAt: { $gte: new Date(Date.now() - 30 * 60 * 1000) },
      });
      if (likeRecent) {
        likeRecent.title = likeTitle;
        likeRecent.message = likeMessage;
        await likeRecent.save().catch(() => {});
      } else {
        await Notification.create({
          userId: post.userId,
          type: 'post_like',
          title: likeTitle,
          message: likeMessage,
          relatedUserId: toObjectId(userId),
          relatedData: { postId: String(post._id) },
        }).catch(() => {});
        try {
          const { sendPushToUser } = await import('../utils/push');
          await sendPushToUser(String(post.userId), likeTitle, likeMessage, {
            type: 'post_like',
            relatedUserId: String(userId),
            postId: String(post._id),
          });
        } catch (e) {
          console.error('[PUSH] Error post_like:', e);
        }
      }
      broadcastSse([String(post.userId)], 'social_update', {
        postId: String(post._id),
        kind: story ? 'story_like' : 'post_like',
        likeCount: post.likes.length,
        fromId: String(userId),
        fromName: me?.name || undefined,
      });
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
    if (!(await canSeeContent(userId, String(post.userId)))) {
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
      if (!(await canSeeContent(userId, String(post.userId)))) {
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
        try {
          const { sendPushToUser } = await import('../utils/push');
          await sendPushToUser(ownerId, story ? 'Historia' : 'Nuevo comentario', snippet, {
            type: 'post_comment',
            screen: 'social',
            tab: 'chat',
            peerId: String(userId),
            postId: String(post._id),
          });
        } catch (e) {
          console.error('[PUSH] Error post_comment:', e);
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
          available: true,
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
        if (!(await chatIsOpen(ownerId, userId))) {
          await ensurePendingChatRequest(userId, ownerId, created.text);
        }
      }
      const otherCommenters = await PostComment.distinct('userId', {
        postId: post._id,
        userId: { $nin: [toObjectId(userId), post.userId] },
      });
      if (otherCommenters.length > 0) {
        const replyTitle = 'Respuesta a tu comentario';
        const replyMessage = `${me?.name || 'Alguien'} ha respondido: ${created.text.slice(0, 80)}`;
        await Notification.insertMany(
          otherCommenters.map(uid => ({
            userId: uid,
            type: 'post_comment_reply' as const,
            title: replyTitle,
            message: replyMessage,
            relatedUserId: toObjectId(userId),
            relatedData: { postId: String(post._id) },
          }))
        ).catch(() => {});
        try {
          const { sendPushToUsers } = await import('../utils/push');
          await sendPushToUsers(otherCommenters.map(id => String(id)), replyTitle, replyMessage, {
            type: 'post_comment_reply',
            relatedUserId: String(userId),
            postId: String(post._id),
          });
        } catch (e) {
          console.error('[PUSH] Error post_comment_reply:', e);
        }
      }
      const notifyIds = otherCommenters
        .map(id => String(id))
        .filter(id => id !== String(userId) && !(story && id === ownerId));
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
      await ChatMessage.updateMany(
        { 'storyReply.postId': String(post._id) },
        { $set: { 'storyReply.mediaKey': '' } }
      );
      await post.deleteOne();
      res.json({ message: 'Publicación eliminada' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

export default router;
