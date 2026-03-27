import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOG_DIR = path.join(__dirname, '../../logs');
const LOG_FILE = path.join(LOG_DIR, 'server.log');
const ERROR_FILE = path.join(LOG_DIR, 'errors.log');

// Asegurar que el directorio de logs existe
function ensureLogDirectory(): void {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      console.log(`📁 Directorio de logs creado: ${LOG_DIR}`);
    }
  } catch (error) {
    console.error('❌ Error creando directorio de logs:', error);
  }
}

// Inicializar el directorio al cargar el módulo
ensureLogDirectory();

function getTimestamp(): string {
  return new Date().toISOString();
}

function writeToFile(filePath: string, message: string): void {
  try {
    // Asegurar que el directorio existe antes de escribir
    ensureLogDirectory();
    
    // Escribir directamente (appendFileSync crea el archivo si no existe)
    fs.appendFileSync(filePath, message + '\n', 'utf8');
  } catch (error: any) {
    // Si falla escribir al archivo, al menos mostrar en consola
    console.error('❌ Error escribiendo al archivo de log:', error?.message || String(error));
    console.error('   Ruta intentada:', filePath);
    console.error('   Directorio existe:', fs.existsSync(LOG_DIR));
    console.error('   Error completo:', error);
  }
}

function formatMeta(meta: unknown): string {
  if (meta === undefined || meta === null) return '';
  if (typeof meta === 'string') return ` ${meta}`;
  try {
    const s = JSON.stringify(meta);
    return s.length > 500 ? ` ${s.slice(0, 500)}…` : ` ${s}`;
  } catch {
    return ' [meta]';
  }
}

export const logger = {
  /** Un solo renglón en consola; el segundo argumento va compacto (sin pretty-print de páginas enteras). */
  info: (message: string, meta?: unknown) => {
    const logMessage = `[${getTimestamp()}] [INFO] ${message}${formatMeta(meta)}`;
    console.log(logMessage);
    writeToFile(LOG_FILE, logMessage);
  },

  error: (message: string, error?: any) => {
    const errorDetails = error 
      ? `\n  Tipo: ${error?.name || 'Unknown'}\n  Mensaje: ${error?.message || String(error)}\n  Stack: ${error?.stack || 'N/A'}`
      : '';
    const logMessage = `[${getTimestamp()}] [ERROR] ${message}${errorDetails}`;
    console.error(logMessage);
    writeToFile(ERROR_FILE, logMessage);
    writeToFile(LOG_FILE, logMessage);
  },

  warn: (message: string, meta?: unknown) => {
    const logMessage = `[${getTimestamp()}] [WARN] ${message}${formatMeta(meta)}`;
    console.warn(logMessage);
    writeToFile(LOG_FILE, logMessage);
  }
};

// Crear archivos de log vacíos al inicializar
try {
  ensureLogDirectory();
  if (!fs.existsSync(LOG_FILE)) {
    fs.writeFileSync(LOG_FILE, `[${getTimestamp()}] [INFO] Sistema de logs inicializado\n`, 'utf8');
  }
  if (!fs.existsSync(ERROR_FILE)) {
    fs.writeFileSync(ERROR_FILE, `[${getTimestamp()}] [INFO] Archivo de errores inicializado\n`, 'utf8');
  }
} catch (error) {
  console.error('❌ Error inicializando archivos de log:', error);
}
