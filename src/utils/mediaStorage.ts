import { createReadStream, existsSync, mkdirSync, promises as fs } from 'fs';
import { extname, join, resolve } from 'path';
import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import { logger } from './logger';

/**
 * Almacén de fotos y vídeos del feed. Hoy escribe en el disco del servidor y los metadatos
 * viven en Mongo; para pasar a S3 basta con `MEDIA_DRIVER=s3` y las variables de AWS, sin
 * tocar rutas ni cliente: lo único que se guarda en la base de datos es la clave del archivo.
 */
export interface StoredMedia {
  key: string;
  mimeType: string;
  size: number;
}

export interface MediaReadResult {
  stream: Readable;
  mimeType: string;
  /** Bytes del trozo devuelto. */
  size: number;
  /** Tamaño completo del archivo (para las cabeceras Content-Range del vídeo). */
  totalSize: number;
}

export interface MediaRange {
  start: number;
  end: number;
}

interface MediaDriver {
  save(buffer: Buffer, mimeType: string): Promise<StoredMedia>;
  read(key: string, range?: MediaRange): Promise<MediaReadResult | null>;
  /** Tamaño del archivo sin abrirlo, para resolver el rango pedido por el reproductor. */
  size(key: string): Promise<number | null>;
  remove(key: string): Promise<void>;
  /**
   * URL para que el navegador descargue el archivo directamente del CDN, sin pasar por
   * este servidor. `null` significa "sírvelo tú": es lo que ocurre en local.
   *
   * Importa para la factura: con el vídeo pasando por Node se paga el tráfico dos veces
   * (almacén → servidor y servidor → usuario) y encima no hay caché de CDN.
   * Ver docs/costes-almacenamiento.md.
   */
  publicUrl(key: string): Promise<string | null>;
}

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
};

export function isSupportedMediaType(mimeType: string): boolean {
  return Object.prototype.hasOwnProperty.call(EXTENSION_BY_MIME, mimeType);
}

export function mediaKindFromMime(mimeType: string): 'image' | 'video' {
  return mimeType.startsWith('video/') ? 'video' : 'image';
}

/** Clave con extensión real: así el navegador reproduce el vídeo sin adivinar el tipo. */
function buildKey(mimeType: string): string {
  const now = new Date();
  const folder = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return `${folder}/${randomUUID()}${EXTENSION_BY_MIME[mimeType] ?? '.bin'}`;
}

const MIME_BY_EXTENSION: Record<string, string> = Object.entries(EXTENSION_BY_MIME).reduce(
  (acc, [mime, ext]) => ({ ...acc, [ext]: mime }),
  {}
);

class LocalDiskDriver implements MediaDriver {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
    if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true });
  }

  /** Impide que una clave manipulada («../../.env») saque el lector fuera de la carpeta de medios. */
  private pathFor(key: string): string | null {
    const full = resolve(join(this.root, key));
    return full.startsWith(this.root) ? full : null;
  }

  async save(buffer: Buffer, mimeType: string): Promise<StoredMedia> {
    const key = buildKey(mimeType);
    const full = this.pathFor(key);
    if (!full) throw new Error('Clave de medio inválida');
    await fs.mkdir(resolve(join(full, '..')), { recursive: true });
    await fs.writeFile(full, buffer);
    return { key, mimeType, size: buffer.length };
  }

  async size(key: string): Promise<number | null> {
    const full = this.pathFor(key);
    if (!full || !existsSync(full)) return null;
    return (await fs.stat(full)).size;
  }

  async read(key: string, range?: MediaRange): Promise<MediaReadResult | null> {
    const full = this.pathFor(key);
    if (!full || !existsSync(full)) return null;
    const stat = await fs.stat(full);
    const mimeType = MIME_BY_EXTENSION[extname(full).toLowerCase()] ?? 'application/octet-stream';
    if (!range) {
      return { stream: createReadStream(full), mimeType, size: stat.size, totalSize: stat.size };
    }
    return {
      stream: createReadStream(full, { start: range.start, end: range.end }),
      mimeType,
      size: range.end - range.start + 1,
      totalSize: stat.size,
    };
  }

  async remove(key: string): Promise<void> {
    const full = this.pathFor(key);
    if (!full || !existsSync(full)) return;
    await fs.unlink(full).catch(() => {});
  }

  /** En disco no hay CDN: lo sirve el propio servidor. */
  async publicUrl(): Promise<string | null> {
    return null;
  }
}

/**
 * S3 con carga diferida del SDK: el paquete solo hace falta cuando de verdad se usa S3,
 * así el servidor arranca igual sin `@aws-sdk/client-s3` instalado.
 */
class S3Driver implements MediaDriver {
  private client: any;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(bucket: string, prefix: string) {
    this.bucket = bucket;
    this.prefix = prefix ? prefix.replace(/^\/+|\/+$/g, '') + '/' : '';
  }

  private async sdk() {
    if (!this.client) {
      // Especificador en variable a propósito: el SDK es opcional y no debe exigirse al compilar.
      const sdkModule = '@aws-sdk/client-s3';
      const mod: any = await import(sdkModule).catch(() => {
        throw new Error('Falta @aws-sdk/client-s3: instálalo para usar MEDIA_DRIVER=s3');
      });
      this.client = {
        s3: new mod.S3Client({
          region: process.env.AWS_REGION || 'eu-west-1',
          /**
           * Con `S3_ENDPOINT` este mismo driver vale para cualquier almacén compatible con
           * S3 (Cloudflare R2, Backblaze B2…). Cambiar de proveedor es cambiar variables
           * de entorno, no código: en Mongo solo se guarda la clave del archivo.
           */
          ...(process.env.S3_ENDPOINT
            ? { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true }
            : {}),
        }),
        mod,
      };
    }
    return this.client;
  }

  async save(buffer: Buffer, mimeType: string): Promise<StoredMedia> {
    const { s3, mod } = await this.sdk();
    const key = buildKey(mimeType);
    await s3.send(
      new mod.PutObjectCommand({
        Bucket: this.bucket,
        Key: `${this.prefix}${key}`,
        Body: buffer,
        ContentType: mimeType,
      })
    );
    return { key, mimeType, size: buffer.length };
  }

  async size(key: string): Promise<number | null> {
    const { s3, mod } = await this.sdk();
    try {
      const out = await s3.send(
        new mod.HeadObjectCommand({ Bucket: this.bucket, Key: `${this.prefix}${key}` })
      );
      return Number(out.ContentLength || 0);
    } catch {
      return null;
    }
  }

  async read(key: string, range?: MediaRange): Promise<MediaReadResult | null> {
    const { s3, mod } = await this.sdk();
    try {
      const out = await s3.send(
        new mod.GetObjectCommand({
          Bucket: this.bucket,
          Key: `${this.prefix}${key}`,
          ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
        })
      );
      const size = Number(out.ContentLength || 0);
      const total = out.ContentRange ? Number(String(out.ContentRange).split('/')[1]) || size : size;
      return {
        stream: out.Body as Readable,
        mimeType: out.ContentType || MIME_BY_EXTENSION[extname(key).toLowerCase()] || 'application/octet-stream',
        size,
        totalSize: total,
      };
    } catch {
      return null;
    }
  }

  async remove(key: string): Promise<void> {
    const { s3, mod } = await this.sdk();
    await s3
      .send(new mod.DeleteObjectCommand({ Bucket: this.bucket, Key: `${this.prefix}${key}` }))
      .catch(() => {});
  }

  /**
   * Dos formas de servir sin pasar por Node, según lo que haya configurado:
   *
   * - `MEDIA_PUBLIC_BASE_URL`: dominio del CDN (CloudFront o el dominio público de R2).
   *   Es lo más barato y lo que mejor cachea, pero el archivo queda accesible a cualquiera
   *   que tenga la URL. Las claves son UUID, así que no se adivinan.
   * - `MEDIA_SIGNED_URLS=true`: URL firmada que caduca. Úsalo si el contenido debe ser
   *   privado de verdad; cachea peor porque la URL cambia.
   *
   * Sin ninguna de las dos devuelve `null` y el servidor sigue sirviendo el archivo.
   */
  async publicUrl(key: string): Promise<string | null> {
    const base = process.env.MEDIA_PUBLIC_BASE_URL;
    if (base) return `${base.replace(/\/+$/, '')}/${this.prefix}${key}`;

    if (process.env.MEDIA_SIGNED_URLS !== 'true') return null;

    try {
      const { s3, mod } = await this.sdk();
      const presignerModule = '@aws-sdk/s3-request-presigner';
      const { getSignedUrl }: any = await import(presignerModule);
      const expiresIn = Number(process.env.MEDIA_SIGNED_URL_TTL || 3600);
      return await getSignedUrl(
        s3,
        new mod.GetObjectCommand({ Bucket: this.bucket, Key: `${this.prefix}${key}` }),
        { expiresIn }
      );
    } catch (err) {
      // Si falla la firma se sirve por el servidor: peor para la factura, pero funciona.
      logger.warn(`[media] No se pudo firmar la URL de ${key}: ${(err as Error).message}`);
      return null;
    }
  }
}

function createDriver(): MediaDriver {
  const driver = (process.env.MEDIA_DRIVER || 'local').toLowerCase();
  if (driver === 's3') {
    const bucket = process.env.AWS_S3_BUCKET;
    if (!bucket) {
      logger.warn('[media] MEDIA_DRIVER=s3 sin AWS_S3_BUCKET: se usa el disco del servidor');
    } else {
      logger.info(`[media] Almacenamiento en S3 (${bucket})`);
      return new S3Driver(bucket, process.env.AWS_S3_PREFIX || 'feed');
    }
  }
  const root = process.env.MEDIA_LOCAL_DIR || join(process.cwd(), 'uploads');
  logger.info(`[media] Almacenamiento en disco (${root})`);
  return new LocalDiskDriver(root);
}

let driverInstance: MediaDriver | null = null;

export function mediaStorage(): MediaDriver {
  if (!driverInstance) driverInstance = createDriver();
  return driverInstance;
}
