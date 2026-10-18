import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { checkPasswordPolicy, readAuth, writeAuth, authPathOf } from '../server/admin/auth.js';
import { loadPublisherConfig } from '../server/config.js';

/**
 * 管理密码命令行工具。
 *
 *   node dist/tools/admin.js status
 *   node dist/tools/admin.js set-password --password <新密码>
 *   node dist/tools/admin.js set-password --password <新密码> --out ./admin-auth.json   # 只生成文件，不写数据目录
 *   echo '<新密码>' | node dist/tools/admin.js set-password --stdin
 *
 * 密码只以 scrypt 派生值落盘，命令输出里不会回显明文。
 */
const USAGE = `用法：
  node dist/tools/admin.js status
  node dist/tools/admin.js set-password --password <新密码> [--out <文件路径>]
  echo '<新密码>' | node dist/tools/admin.js set-password --stdin [--out <文件路径>]

说明：
  - 不传 --out 时写入 $DATA_DIR/admin/auth.json（权限 600）。
  - 传 --out 时只把同一份 JSON 写到指定路径，方便拷到服务器安装。
  - 密码至少 8 位，且同时包含字母和数字。`;

function flagValue(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  return args[index + 1] ?? null;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const command = args[0] ?? '';

  if (command === '' || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return command === '' ? 1 : 0;
  }

  const config = loadPublisherConfig();

  if (command === 'status') {
    const record = await readAuth(config.dataDir);
    if (!record) {
      process.stdout.write(`管理密码：未设置\n数据目录：${config.dataDir}\n`);
      return 0;
    }
    process.stdout.write(
      `管理密码：已设置（${record.algorithm}，N=${record.N}，r=${record.r}，p=${record.p}）\n` +
        `更新时间：${record.updatedAt}\n` +
        `保存位置：${authPathOf(config.dataDir)}\n`,
    );
    return 0;
  }

  if (command === 'set-password') {
    let password = flagValue(args, '--password');
    if (args.includes('--stdin')) password = await readStdin();
    if (!password) {
      process.stderr.write(`缺少密码。\n${USAGE}\n`);
      return 2;
    }
    const problem = checkPasswordPolicy(password);
    if (problem) {
      process.stderr.write(`密码不符合要求：${problem}\n`);
      return 2;
    }
    const out = flagValue(args, '--out');
    const previous = await readAuth(config.dataDir);
    const record = await writeAuth(config.dataDir, password);
    if (out) {
      const target = path.resolve(out);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      process.stdout.write(`已生成：${target}\n`);
    }
    process.stdout.write(
      `管理密码${previous ? '已更新' : '已设置'}：${authPathOf(config.dataDir)}\n` +
        `更新时间：${record.updatedAt}\n`,
    );
    return 0;
  }

  process.stderr.write(`未知命令：${command}\n${USAGE}\n`);
  return 2;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
