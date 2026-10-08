// scripts/gen_certs.js —— 生成本地自签 HTTPS 证书（127.0.0.1 / localhost），供离线 PWA 测试使用
// 仅测试用途；产物：certs/key.pem + certs/cert.pem
const forge = require('node-forge');
const fs = require('fs');
const path = require('path');

const certDir = path.join(__dirname, 'certs');
if (!fs.existsSync(certDir)) fs.mkdirSync(certDir, { recursive: true });

const pki = forge.pki;
const keys = pki.rsa.generateKeyPair(2048);
const cert = pki.createCertificate();
cert.publicKey = keys.publicKey;
cert.serialNumber = '01';
cert.validity.notBefore = new Date(Date.now() - 86400000);
cert.validity.notAfter = new Date(Date.now() + 365 * 86400000);
const attrs = [{ name: 'commonName', value: '127.0.0.1' }];
cert.setSubject(attrs);
cert.setIssuer(attrs);
cert.setExtensions([
  { name: 'basicConstraints', cA: true },
  { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, dataEncipherment: true },
  { name: 'subjectAltName', altNames: [{ type: 2, value: '127.0.0.1' }, { type: 2, value: 'localhost' }] },
]);
cert.sign(keys.privateKey, forge.md.sha256.create());

fs.writeFileSync(path.join(certDir, 'key.pem'), pki.privateKeyToPem(keys.privateKey));
fs.writeFileSync(path.join(certDir, 'cert.pem'), pki.certificateToPem(cert));
console.log('自签证书已生成: ' + path.join(certDir, 'key.pem') + ' / cert.pem');
