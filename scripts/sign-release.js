// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
/**
 * 给更新包签名（P1-1）。
 *
 * 签名对象 = **包文件的字节**（分离式签名），不是 feed 文档。
 * 理由：`sha256` 必填之后客户端本来就要对整包算一次哈希，在同一份字节上验签几乎零额外成本；
 *      而"签 feed 文档"要引入 JSON 规范化，序列化差一个空格就全挂，脆弱且收益有限。
 *
 * 用法：
 *   node scripts/sign-release.js --zip <包> --key <私钥.pem> [--key-id <id>] [--out <文件>]
 *   环境变量 WBWP_SIGN_KEY / WBWP_SIGN_KEY_ID 可代替 --key / --key-id
 *
 * 输出：base64 签名（一行）。`--out` 时同时写文件，方便 release-feed.js 读取。
 *
 * ⚠️ 私钥只在本机用。**不要**放进 CI Secrets —— 那等于把签名权交给托管方，
 *    而 P1-1 的整个目的就是"托管方被入侵也不能投放可安装的更新包"。
 */
const fs = require('fs');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const zipPath = arg('--zip');
const keyPath = arg('--key', process.env.WBWP_SIGN_KEY || '');
const keyId = arg('--key-id', process.env.WBWP_SIGN_KEY_ID || 'wbwp-' + new Date().getFullYear() + 'a');
const outPath = arg('--out', '');

function die(msg) { console.error(msg); process.exit(2); }

if (!zipPath || !keyPath) {
  die('用法: node scripts/sign-release.js --zip <包> --key <私钥.pem> [--key-id <id>] [--out <文件>]');
}
if (!fs.existsSync(zipPath)) die('找不到要签的包: ' + zipPath);
if (!fs.existsSync(keyPath)) die('找不到私钥: ' + keyPath);

let priv;
try {
  priv = crypto.createPrivateKey({ key: fs.readFileSync(keyPath, 'utf8'), format: 'pem', type: 'pkcs8' });
} catch (e) {
  die('私钥读取失败（需要 PKCS#8 PEM 的 Ed25519 私钥）: ' + (e && e.message));
}
if (priv.asymmetricKeyType !== 'ed25519') die('私钥类型不是 ed25519，实际是 ' + priv.asymmetricKeyType);

const data = fs.readFileSync(zipPath);
const signedAt = new Date().toISOString();
const signature = crypto.sign(null, data, priv).toString('base64');

// 自检：签完立刻用对应公钥验一遍，签错了当场发现，而不是等用户装不上才发现
const pub = crypto.createPublicKey(priv);
if (!crypto.verify(null, data, pub, Buffer.from(signature, 'base64'))) {
  die('自检失败：刚生成的签名验不过（这不该发生，请检查私钥）。');
}

if (outPath) {
  fs.mkdirSync(require('path').dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, signature + '\n');
}

console.log(signature);
console.error('已签名：' + require('path').basename(zipPath) +
  '  ' + data.length + ' 字节  keyId=' + keyId + '  at=' + signedAt);
console.error('（私钥未离开本机；签名已自检通过）');
