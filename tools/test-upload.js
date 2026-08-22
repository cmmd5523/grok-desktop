// End-to-end: upload a PDF via grok2api file content block, ask Grok to read it.
const BASE = 'http://md-grok.de5.net/v1';
const KEY = 'sk-mdchen';
const MODEL = process.env.MODEL || 'grok-4.3-fast';

// Build a minimal but valid one-page PDF with visible text.
function buildPdf(text) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${90 + text.length} >>\nstream\nBT /F1 18 Tf 72 720 Td (${text}) Tj ET\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 0; i < objs.length; i++) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

(async () => {
  const pdfBuf = buildPdf('Uploaded financial report: revenue 1.2 million, profit 340k, growth 18 percent.');
  const dataUri = 'data:application/pdf;base64,' + pdfBuf.toString('base64');

  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '请阅读附件 PDF,然后回答:收入是多少?利润率是多少?不要编造。' },
            { type: 'file', file: { data: dataUri } },
          ],
        },
      ],
    }),
  });
  console.log('status:', res.status);
  const text = await res.text();
  if (res.status !== 200) { console.log(text.slice(0, 400)); return; }
  const json = JSON.parse(text);
  const m = json.choices[0].message;
  console.log('reply:', JSON.stringify(m.content));
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
