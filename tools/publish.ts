#!/usr/bin/env node
/**
 * Fennec Share 发布 CLI。
 *
 *   node dist/tools/publish.js <subcommand> [options]
 *
 * 子命令：validate | publish | list | unpublish | rollback | history | backup | restore | cleanup | seed | help
 * 所有路径参数建议使用绝对路径；manifest 内的相对路径以 manifest 所在目录为准。
 * 退出码：0 成功，1 执行失败，2 输入/manifest 不合法。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findProject } from '../shared/catalog.js';
import { loadPublisherConfig } from '../server/config.js';
import { PublishError, isPublishError } from './lib/errors.js';
import { publishProject, type PublishResult } from './lib/publish.js';
import { buildList, rollbackProject, unpublishProject } from './lib/manage.js';
import { backupData, cleanupStaging, restoreData } from './lib/backup.js';
import { readCatalogFile } from './lib/catalog-io.js';
import { loadManifest } from './lib/manifest.js';
import { loadLimits } from './lib/manifest.js';

const HELP = `Fennec Share 发布 CLI

用法：
  node dist/tools/publish.js <命令> [选项]

命令：
  validate --manifest <文件>            只校验 manifest 与包内容，不写任何文件
  publish  --manifest <文件> [--dry-run] 新增或更新项目（--dry-run 等价 validate，但会打印将要发布的内容）
  list     [--json]                     列出已发布项目
  unpublish --slug <slug> [--reason 文本] 下架项目（保留文件，首页/试玩/下载统一 404）
  rollback --slug <slug> [--to <seq|releaseId>] [--list] 回滚到上一个或指定历史状态
  history  --slug <slug>                查看某个项目的发布历史状态
  backup   [--out <目录>]               备份 catalog 与全部项目文件
  restore  --from <备份目录> [--dry-run] 校验并恢复备份
  cleanup  [--older-than-hours N]       清理 staging 残留（不碰已发布内容）
  seed     --demo-dir <目录> [--json]   导入示例项目（跳过同名非示例项目）

通用选项：
  --json      输出单个 JSON 对象（便于程序解析）
  -h, --help  显示本帮助

环境变量：
  DATA_DIR              发布数据根目录（必填，建议绝对路径）
  PUBLIC_BASE_URL       可选，输出绝对 URL 时使用，如 https://share.fennecmomo.top
  LOG_LEVEL             debug|info|warn|error
  FH_PUBLISH_MAX_*      发布限额，见 docs/HERMES_PUBLISH_GUIDE.md

示例：
  DATA_DIR=/srv/fennec-share/data node dist/tools/publish.js publish --manifest /tmp/demo/project.json
`;

const BOOLEAN_FLAGS = new Set(['json', 'dry-run', 'list', 'help']);

interface ParsedArgs {
  command: string | null;
  flags: Map<string, string | true>;
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  let command: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === '-h' || arg === '--help') {
      flags.set('help', true);
    } else if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
      } else if (BOOLEAN_FLAGS.has(body)) {
        flags.set(body, true);
      } else {
        const next = argv[index + 1];
        if (next === undefined || next.startsWith('--')) {
          throw new PublishError('invalid_args', `参数 --${body} 需要一个值`);
        }
        flags.set(body, next);
        index += 1;
      }
    } else if (command === null) {
      command = arg;
    } else {
      positional.push(arg);
    }
  }
  return { command, flags, positional };
}

function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

function boolFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true || args.flags.get(name) === 'true';
}

function requireStringFlag(args: ParsedArgs, name: string): string {
  const value = stringFlag(args, name);
  if (!value) throw new PublishError('invalid_args', `缺少必需参数 --${name}`);
  return value;
}

function humanPublish(result: PublishResult): string {
  const lines: string[] = [];
  const statusText =
    result.status === 'created'
      ? '已新增'
      : result.status === 'updated'
        ? '已更新'
        : result.status === 'validated'
          ? '校验通过（未写入）'
          : '无需更新';
  lines.push(`${result.status === 'unchanged' ? 'ℹ' : '✔'} 项目 ${result.slug} ${statusText}`);
  lines.push(`  标题：${result.title}`);
  lines.push(`  更新部分：${result.parts.length > 0 ? result.parts.join(', ') : '(无)'}`);
  if (result.releaseId) lines.push(`  发布版本：${result.releaseId}`);
  if (result.web) {
    lines.push(`  在线体验：${result.web.absoluteUrl ?? result.web.publicUrl}（入口 ${result.web.entry}，SPA fallback ${result.web.spaFallback ? '开启' : '关闭'}）`);
  } else {
    lines.push('  在线体验：无');
  }
  if (result.downloads.length === 0) {
    lines.push('  下载：无');
  } else {
    lines.push(`  下载（${result.downloads.length}）：`);
    for (const download of result.downloads) {
      lines.push(
        `    - ${download.fileName}  [${download.platform}]  ${download.size} 字节  ${download.absoluteUrl ?? download.publicUrl}${download.isDefault ? '  (默认)' : ''}`,
      );
    }
  }
  if (result.warnings.length > 0) {
    lines.push('  提示：');
    for (const warning of result.warnings) lines.push(`    ! ${warning}`);
  }
  lines.push(`  catalog revision：${result.catalogRevision}`);
  lines.push(`  ${result.message}`);
  return lines.join('\n');
}

async function runValidate(args: ParsedArgs): Promise<void> {
  const manifestPath = requireStringFlag(args, 'manifest');
  const limits = loadLimits();
  const manifest = loadManifest(manifestPath, limits);
  if (boolFlag(args, 'json')) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          manifest: {
            path: manifest.manifestPath,
            slug: manifest.slug,
            title: manifest.title,
            categories: manifest.categories,
            published: manifest.published,
            web: manifest.web ? { kind: manifest.web.kind, source: manifest.web.sourcePath, entry: manifest.web.entry, spaFallback: manifest.web.spaFallback } : null,
            cover: manifest.cover === undefined ? 'keep' : manifest.cover === null ? 'clear' : manifest.cover.sourcePath,
            screenshots: manifest.screenshots?.length ?? 0,
            downloads: manifest.downloads.map((download) => ({
              fileName: download.fileName,
              platform: download.platform,
              version: download.version,
              size: download.size,
            })),
            removeDownloads: manifest.removeDownloads,
          },
          warnings: manifest.warnings,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  process.stdout.write(`✔ manifest 校验通过：${manifest.slug}（${manifest.title}）\n`);
  process.stdout.write(`  分类：${manifest.categories.join(', ')}\n`);
  process.stdout.write(
    `  web：${manifest.web ? `${manifest.web.kind} → ${manifest.web.sourcePath}` : '无（保留现有）'}\n`,
  );
  process.stdout.write(`  下载：${manifest.downloads.length} 个\n`);
  for (const warning of manifest.warnings) process.stdout.write(`  ! ${warning}\n`);
}

async function runPublish(args: ParsedArgs): Promise<void> {
  const config = loadPublisherConfig();
  const manifestPath = requireStringFlag(args, 'manifest');
  const result = await publishProject(config, { manifestPath, dryRun: boolFlag(args, 'dry-run') });
  if (boolFlag(args, 'json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${humanPublish(result)}\n`);
}

async function runList(args: ParsedArgs): Promise<void> {
  const config = loadPublisherConfig();
  const catalog = await readCatalogFile(config.dataDir);
  const entries = buildList(catalog);
  if (boolFlag(args, 'json')) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, catalogRevision: catalog.revision, generatedAt: catalog.generatedAt, projects: entries }, null, 2)}\n`,
    );
    return;
  }
  process.stdout.write(`catalog revision ${catalog.revision}，共 ${entries.length} 个项目\n`);
  if (entries.length === 0) {
    process.stdout.write('（暂无项目）\n');
    return;
  }
  for (const entry of entries) {
    const flags = [entry.published ? '已发布' : '已下架', entry.demo ? '示例' : '', entry.hasWeb ? '可试玩' : '', `${entry.downloadCount} 个下载`]
      .filter((part) => part.length > 0)
      .join(' · ');
    process.stdout.write(`- ${entry.slug}  ${entry.title}  [${flags}]  更新于 ${entry.updatedAt}\n`);
  }
}

async function runUnpublish(args: ParsedArgs): Promise<void> {
  const config = loadPublisherConfig();
  const result = await unpublishProject(config, {
    slug: requireStringFlag(args, 'slug'),
    reason: stringFlag(args, 'reason'),
  });
  if (boolFlag(args, 'json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${result.status === 'unpublished' ? '✔' : 'ℹ'} ${result.message}\n`);
}

async function runRollback(args: ParsedArgs): Promise<void> {
  const config = loadPublisherConfig();
  const result = await rollbackProject(config, {
    slug: requireStringFlag(args, 'slug'),
    to: stringFlag(args, 'to'),
    listOnly: boolFlag(args, 'list'),
  });
  if (boolFlag(args, 'json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (result.status === 'listed') {
    process.stdout.write(`项目 ${result.slug} 的历史状态（catalog revision ${result.catalogRevision}）：\n`);
    for (const entry of [...result.history].reverse()) {
      process.stdout.write(
        `  #${entry.seq}  ${entry.action.padEnd(9)}  ${entry.at}  release=${entry.releaseId ?? '-'}  published=${entry.published}  downloads=${entry.downloadCount}  ${entry.title}\n`,
      );
    }
    process.stdout.write(`${result.message}\n`);
    return;
  }
  process.stdout.write(`${result.status === 'rolled_back' ? '✔' : 'ℹ'} ${result.message}\n`);
}

async function runBackup(args: ParsedArgs): Promise<void> {
  const config = loadPublisherConfig();
  const result = await backupData(config, { out: stringFlag(args, 'out') });
  if (boolFlag(args, 'json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`✔ ${result.message}\n`);
  process.stdout.write(`  catalog revision：${result.catalogRevision}，项目数：${result.projectCount}\n`);
}

async function runRestore(args: ParsedArgs): Promise<void> {
  const config = loadPublisherConfig();
  const result = await restoreData(config, {
    from: requireStringFlag(args, 'from'),
    dryRun: boolFlag(args, 'dry-run'),
  });
  if (boolFlag(args, 'json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`✔ ${result.message}\n`);
}

async function runCleanup(args: ParsedArgs): Promise<void> {
  const config = loadPublisherConfig();
  const olderThan = stringFlag(args, 'older-than-hours');
  const result = await cleanupStaging(config, {
    olderThanHours: olderThan ? Number(olderThan) : undefined,
  });
  if (boolFlag(args, 'json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`✔ ${result.message}\n`);
}

async function runSeed(args: ParsedArgs): Promise<void> {
  const config = loadPublisherConfig();
  const demoRoot = path.resolve(stringFlag(args, 'demo-dir') ?? 'demo');
  const projectsRoot = path.join(demoRoot, 'projects');
  let entries: string[];
  try {
    entries = (await fs.promises.readdir(projectsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    throw new PublishError('invalid_args', `找不到示例目录：${projectsRoot}`);
  }

  const catalog = await readCatalogFile(config.dataDir);
  const results: Array<{ manifest: string; status: string; slug: string; message: string }> = [];
  const failures: Array<{ manifest: string; error: string }> = [];
  const skipped: Array<{ manifest: string; reason: string }> = [];

  for (const name of entries) {
    const manifestPath = path.join(projectsRoot, name, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = loadManifest(manifestPath, loadLimits());
      const existing = findProject(catalog, manifest.slug);
      if (existing && !existing.demo) {
        skipped.push({ manifest: manifestPath, reason: `已存在同名非示例项目 ${manifest.slug}，跳过以免覆盖用户数据` });
        continue;
      }
      const result = await publishProject(config, { manifestPath });
      results.push({ manifest: manifestPath, status: result.status, slug: result.slug, message: result.message });
    } catch (error) {
      failures.push({ manifest: manifestPath, error: isPublishError(error) ? `${error.code}: ${error.message}` : String(error) });
    }
  }

  if (boolFlag(args, 'json')) {
    process.stdout.write(`${JSON.stringify({ ok: failures.length === 0, results, failures, skipped }, null, 2)}\n`);
  } else {
    for (const result of results) process.stdout.write(`✔ ${result.slug}：${result.message}\n`);
    for (const item of skipped) process.stdout.write(`ℹ 跳过 ${item.manifest}：${item.reason}\n`);
    for (const failure of failures) process.stderr.write(`✘ ${failure.manifest}：${failure.error}\n`);
    process.stdout.write(`共处理 ${entries.length} 个示例目录：成功 ${results.length}，跳过 ${skipped.length}，失败 ${failures.length}\n`);
  }
  if (failures.length > 0) process.exit(1);
}

function repoVersion(): string {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    path.resolve(thisDir, '..', '..', 'package.json'),
    path.resolve(thisDir, '..', 'package.json'),
  ]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { version?: unknown };
      if (typeof parsed.version === 'string') return parsed.version;
    } catch {
      // 继续尝试
    }
  }
  return 'unknown';
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (boolFlag(args, 'help') || args.command === null || args.command === 'help') {
    process.stdout.write(HELP);
    return;
  }

  switch (args.command) {
    case 'validate':
      await runValidate(args);
      break;
    case 'publish':
      await runPublish(args);
      break;
    case 'list':
      await runList(args);
      break;
    case 'unpublish':
      await runUnpublish(args);
      break;
    case 'rollback':
      await runRollback(args);
      break;
    case 'history':
      await runRollback({ ...args, flags: new Map(args.flags).set('list', true) });
      break;
    case 'backup':
      await runBackup(args);
      break;
    case 'restore':
      await runRestore(args);
      break;
    case 'cleanup':
      await runCleanup(args);
      break;
    case 'seed':
      await runSeed(args);
      break;
    case 'version':
      process.stdout.write(`fennec-share publish CLI ${repoVersion()}\n`);
      break;
    default:
      throw new PublishError('invalid_args', `未知命令：${args.command}（用 --help 查看用法）`);
  }
}

main().catch((error: unknown) => {
  if (isPublishError(error)) {
    process.stderr.write(`✘ ${error.code}: ${error.message}\n`);
    const details = error.details as { issues?: string[] } | undefined;
    if (details?.issues) {
      for (const issue of details.issues) process.stderr.write(`  - ${issue}\n`);
    }
    process.exit(error.exitCode);
  }
  process.stderr.write(`✘ ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
