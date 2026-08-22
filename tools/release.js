#!/usr/bin/env node
// 一键发布: bump 版本号 -> git commit -> 打 v* tag -> push(触发 CI 构建 Release)
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const pkgPath = () => path.join(ROOT, 'package.json');
const readVersion = () => JSON.parse(fs.readFileSync(pkgPath(), 'utf8')).version;
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const kind = (args.find((a) => !a.startsWith('--')) || 'patch').toLowerCase();

const KINDS = ['patch', 'minor', 'major'];
if (!KINDS.includes(kind)) {
  console.error(`用法: npm run release -- <${KINDS.join('|')}> [--dry-run]`);
  process.exit(1);
}

function sh(cmd) {
  console.log(`> ${cmd}`);
  if (!dryRun) execSync(cmd, { stdio: 'inherit', cwd: ROOT });
}

try {
  // 工作区必须干净,避免把未提交改动卷进发布 commit
  const status = execSync('git status --porcelain', { cwd: ROOT }).toString().trim();
  if (status && !dryRun) {
    console.error('工作区有未提交的改动,请先 commit 或 stash:');
    console.error(status);
    process.exit(1);
  }

  // 读取当前版本并计算下一个版本(npm version 负责更新 package.json + package-lock.json)
  const pkg = readVersion();
  console.log(`当前版本: v${pkg}  发布类型: ${kind}${dryRun ? '  [dry-run]' : ''}`);

  sh(`npm version ${kind} -m "release: %s"`);
  sh('git push origin main');
  sh('git push origin --tags');

  const next = readVersion();
  console.log(
    dryRun
      ? `\n(dry-run) 将发布 v${next},CI 会构建安装包并创建 GitHub Release。`
      : `\n✅ 已发布 v${next}。GitHub Actions 正在构建 Release 安装包(约 3-5 分钟)。`
  );
} catch (err) {
  console.error('\n发布中断:', (err && err.stderr ? err.stderr.toString() : '') || err.message || err);
  process.exit(1);
}
