'use strict';
// 腾讯云 OCR 客户端（手写体 + 表格识别），纯 Node 标准库实现，含 TC3-HMAC-SHA256 签名。
// 文档: https://cloud.tencent.com/document/product/866/49525 (RecognizeTableOCR V2)
//       https://cloud.tencent.com/document/product/866/ (GeneralHandwritingOCR)

const crypto = require('crypto');
const https = require('https');

const ENDPOINT = 'ocr.tencentcloudapi.com';
const SERVICE = 'ocr';
const VERSION = '2018-11-19';
const REGION = process.env.TENCENT_REGION || 'ap-guangzhou';

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}
function hmac(secret, data) {
  return crypto.createHmac('sha256', secret).update(data, 'utf8').digest();
}

// TC3-HMAC-SHA256 签名
function buildAuthorization(secretId, secretKey, action, payloadStr, timestamp) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10); // UTC YYYY-MM-DD
  const hashedPayload = sha256Hex(payloadStr);
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${ENDPOINT}\n`;
  const signedHeaders = 'content-type;host';
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    hashedPayload,
  ].join('\n');

  const credentialScope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = [
    'TC3-HMAC-SHA256',
    String(timestamp),
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac('TC3' + secretKey, date);
  const kService = hmac(kDate, SERVICE);
  const kSigning = hmac(kService, 'tc3_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  return `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

function callOCR(action, payload, secretId, secretKey) {
  return new Promise((resolve, reject) => {
    const payloadStr = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const authorization = buildAuthorization(secretId, secretKey, action, payloadStr, timestamp);
    const body = Buffer.from(payloadStr, 'utf8');

    const options = {
      hostname: ENDPOINT,
      path: '/',
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json; charset=utf-8',
        Host: ENDPOINT,
        'X-TC-Action': action,
        'X-TC-Timestamp': String(timestamp),
        'X-TC-Version': VERSION,
        'X-TC-Region': REGION,
        'Content-Length': body.length,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.Response && json.Response.Error) {
            return reject(new Error(`${json.Response.Error.Code}: ${json.Response.Error.Message}`));
          }
          resolve(json.Response);
        } catch (e) {
          reject(new Error('解析腾讯云响应失败: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('请求腾讯云 OCR 超时')));
    req.write(body);
    req.end();
  });
}

// 表格识别（V2）—— 返回带网格坐标的单元格 + Base64 Excel
async function recognizeTable(imageBase64, creds) {
  return callOCR('RecognizeTableOCR', { ImageBase64: imageBase64 }, creds.secretId, creds.secretKey);
}

// 通用手写体识别 —— 返回行级文本，EnableWordPolygon 附带逐字坐标
async function recognizeHandwriting(imageBase64, creds) {
  return callOCR(
    'GeneralHandwritingOCR',
    { ImageBase64: imageBase64, EnableWordPolygon: true },
    creds.secretId,
    creds.secretKey
  );
}

module.exports = { recognizeTable, recognizeHandwriting, callOCR };
