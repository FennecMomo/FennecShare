import fs from 'node:fs/promises';
import http from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);

async function main(): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true }).catch((error: unknown) => {
    logger.warn('无法创建 DATA_DIR，若目录不可写则发布功能不可用', { error: String(error) });
  });

  const { app } = createApp({ config, logger });
  const server = http.createServer(app);
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      logger.error(`端口 ${config.port} 已被占用，请换一个 PORT 或停止占用进程`, { host: config.host });
    } else if (error.code === 'EACCES') {
      logger.error(`没有权限监听 ${config.host}:${config.port}`, { code: error.code });
    } else {
      logger.error('HTTP 服务启动失败', { error: String(error), code: error.code ?? '' });
    }
    process.exit(1);
  });

  logger.info('Fennec Share 已启动', {
    url: `http://${config.host}:${config.port}`,
    dataDir: config.dataDir,
    webDistDir: config.webDistDir,
    node: process.version,
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('收到退出信号，开始优雅关闭', { signal });
    const forceTimer = setTimeout(() => {
      logger.warn('优雅关闭超时，强制退出');
      process.exit(1);
    }, 8000);
    forceTimer.unref();

    server.close((error) => {
      clearTimeout(forceTimer);
      if (error) {
        logger.error('关闭 HTTP 服务失败', { error: String(error) });
        process.exit(1);
      }
      logger.info('已停止监听，进程退出');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error('未捕获的 Promise 拒绝', { reason: String(reason) });
  });
  process.on('uncaughtException', (error) => {
    logger.error('未捕获的异常', { error: error.stack ?? String(error) });
    shutdown('uncaughtException');
  });
}

main().catch((error: unknown) => {
  logger.error('启动失败', { error: error instanceof Error ? error.stack ?? error.message : String(error) });
  process.exit(1);
});
