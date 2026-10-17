// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
/**
 * 生成更新包签名用的 Ed25519 密钥对（P1-1）。
 *
 * 为什么单独一个脚本：私钥**绝不能进仓库、也不能进 CI Secrets** ——
 * 私钥一旦交给托管方，签名就形同虚设（那正是 P1-1 要防的事）。
 * 所以签发流程固定为：本机跑一次本脚本 → 私钥留本地 → 每次发版用 sign-release.js 签。
 *
 * 用法：
 *   node scripts/init-signing-key.js --out <目录> [--key-id wbwp-2026a] [--force]
 *
 * 产出：
 *   <目录>/<keyId>.priv.pem   私钥（PKCS#8 PEM）—— 只留本地，别提交、别上传
 *   <目录>/<keyId>.pub.pem    公钥（SPKI PEM，备份/人看用）
 *   控制台打印可直接粘进 core/update.js `UPDATE_PUBKEYS` 的一行
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const outDir = arg('--out', path.join(process.env.USERPROFILE || '.', 'wbwp-keys'));
const keyId = arg('--key-id', 'wbwp-' + new Date().getFullYear() + 'a');
const force = argv.includes('--force');

const privPath = path.join(outDir, keyId + '.priv.pem');
const pubPath = path.join(outDir, keyId + '.pub.pem');

if (!force && (fs.existsSync(privPath) || fs.existsSync(pubPath))) {
  console.error('密钥已存在: ' + privPath);
  console.error('要覆盖请显式加 --force —— 覆盖后**用旧钥匙签过的包将全部验签失败**。');
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
// 客户端里存的是 **DER(SPKI) 的 base64**：没有 PEM 头尾和换行，塞进代码最省事
const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

fs.writeFileSync(privPath, privPem, { mode: 0o600 });
fs.writeFileSync(pubPath, pubPem);

console.log('已生成 Ed25519 密钥对（keyId = ' + keyId + '）：');
console.log('  私钥（**只留本地，绝不提交/上传**）: ' + privPath);
console.log('  公钥（备份/人看）                  : ' + pubPath);
console.log('');
console.log('把下面这一行粘进 core/update.js 的 UPDATE_PUBKEYS 数组：');
console.log("  { keyId: '" + keyId + "', publicKey: '" + pubB64 + "' },");
console.log('');
console.log('给更新包签名：');
console.log('  node scripts/sign-release.js --zip landing/workbuddy-wallpaper.zip --key "' + privPath + '" --key-id ' + keyId);
