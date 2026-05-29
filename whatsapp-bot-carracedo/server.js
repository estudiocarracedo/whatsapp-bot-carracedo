import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const VERIFY_TOKEN =
  process.env.WHATSAPP_VERIFY_TOKEN ||
  process.env.VERIFY_TOKEN ||
  'carracedo_whatsapp_2026';

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'carracedo123';
const DB_PATH = path.join(process.cwd(), 'data', 'db.json');
const UPLOAD_DIR = path.join(process.cwd(), 'public', 'uploads');

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(morgan('tiny'));
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

async function readDb() {
  try {
    return JSON.parse(await fs.readFile(DB_PATH, 'utf8'));
  } catch {
    return { conversations: {} };
  }
}

async function writeDb(db) {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
  await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2));
}

function nowIso() {
  return new Date().toISOString();
}

function normalizePhone(phone = '') {
  return phone.replace(/\D/g, '');
}

function normalizePhoneForMeta(phone = '') {
  let clean = normalizePhone(phone);
  if (clean.startsWith('54911')) clean = '54' + clean.slice(3);
  return clean;
}

function classify(text) {
  const t = (text || '').toLowerCase();
  const anmat = /anmat|medical|m[eé]dic|implante|quir[uú]rg|salud|registro/.test(t);
  const importExport = /import|export|aduana|despacho|ncm|sim|sira|licencia|proveedor|china|suiza|eeuu|usa|europa|brasil|uruguay|panam[aá]/.test(t);
  const human = /operador|persona|humano|llamar|asesor|hablar con/.test(t);

  let tag = 'Consulta simple';
  if (anmat) tag = 'Cliente ANMAT';
  else if (importExport) tag = 'Cliente potencial';

  return { tag, wantsHuman: human };
}

function nextBotReply(text, convo) {
  if (!convo.step) convo.step = 'ASK_NAME_COMPANY';

  if (convo.step === 'ASK_NAME_COMPANY') {
    convo.nameCompany = text;
    convo.step = 'ASK_OPERATION';
    return 'Perfecto, gracias. ¿Qué necesitás importar o exportar, desde qué país y en qué estado está la operación?';
  }

  if (convo.step === 'ASK_OPERATION') {
    convo.need = text;
    convo.step = 'ASK_SUPPLIER';
    return 'Gracias. ¿Ya tenés proveedor definido y factura/proforma, o todavía estás evaluando la operación?';
  }

  if (convo.step === 'ASK_SUPPLIER') {
    convo.hasSupplier = text;
    convo.step = 'ASK_ANMAT';
    return 'Entendido. ¿La mercadería requiere intervención de ANMAT, registro, certificado especial o algún organismo extraaduanero?';
  }

  if (convo.step === 'ASK_ANMAT') {
    convo.requiresAnmat = text;
    convo.step = 'DONE';
    return 'Perfecto. Ya recibimos tu consulta ✅ Un operador especializado de Estudio Carracedo revisará la información y continuará la atención a la brevedad.';
  }

  return 'Gracias. Ya tenemos registrada tu consulta ✅ Un operador especializado continuará la atención a la brevedad.';
}

async function sendWhatsAppText(to, text) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    console.log('MODO TEST - no se envía WhatsApp:', { to, text });
    return;
  }

  const cleanTo = normalizePhoneForMeta(to);
  console.log('Enviando WhatsApp a:', cleanTo);

  await axios.post(
    `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to: cleanTo,
      type: 'text',
      text: {
        preview_url: false,
        body: text
      }
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );
}

function getExtensionFromMime(mime = '') {
  if (mime.includes('pdf')) return 'pdf';
  if (mime.includes('jpeg')) return 'jpg';
  if (mime.includes('jpg')) return 'jpg';
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('mpeg')) return 'mp3';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('plain')) return 'txt';
  if (mime.includes('word')) return 'docx';
  if (mime.includes('excel') || mime.includes('spreadsheet')) return 'xlsx';
  return 'bin';
}

async function downloadWhatsAppMedia(mediaId, phone, type, originalFilename = '') {
  if (!WHATSAPP_TOKEN) throw new Error('Falta WHATSAPP_TOKEN');

  const mediaInfoResponse = await axios.get(
    `https://graph.facebook.com/v20.0/${mediaId}`,
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`
      }
    }
  );

  const mediaUrl = mediaInfoResponse.data.url;
  const mimeType = mediaInfoResponse.data.mime_type || '';
  const ext = originalFilename?.includes('.')
    ? originalFilename.split('.').pop()
    : getExtensionFromMime(mimeType);

  await fs.mkdir(UPLOAD_DIR, { recursive: true });

  const safePhone = normalizePhone(phone);
  const filename = `${Date.now()}-${safePhone}-${type}.${ext}`;
  const filePath = path.join(UPLOAD_DIR, filename);

  const fileResponse = await axios.get(mediaUrl, {
    responseType: 'arraybuffer',
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`
    }
  });

  await fs.writeFile(filePath, fileResponse.data);

  return {
    type,
    filename: originalFilename || filename,
    savedFilename: filename,
    mimeType,
    url: `/uploads/${filename}`
  };
}

function extractMessageContent(message) {
  const type = message.type;

  if (type === 'text') {
    return {
      type: 'text',
      text: message.text?.body || '',
      media: null
    };
  }

  if (type === 'document') {
    return {
      type: 'document',
      text: message.document?.caption || 'Documento adjunto',
      mediaId: message.document?.id,
      filename: message.document?.filename || 'documento'
    };
  }

  if (type === 'image') {
    return {
      type: 'image',
      text: message.image?.caption || 'Imagen adjunta',
      mediaId: message.image?.id,
      filename: 'imagen'
    };
  }

  if (type === 'audio') {
    return {
      type: 'audio',
      text: 'Audio adjunto',
      mediaId: message.audio?.id,
      filename: 'audio'
    };
  }

  if (type === 'video') {
    return {
      type: 'video',
      text: message.video?.caption || 'Video adjunto',
      mediaId: message.video?.id,
      filename: 'video'
    };
  }

  return {
    type,
    text: `Mensaje recibido tipo: ${type}`,
    mediaId: null,
    filename: ''
  };
}

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post('/webhook/whatsapp', async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message) return;

    const from = normalizePhone(message.from);
    const content = extractMessageContent(message);

    console.log('Mensaje recibido de:', from, 'Tipo:', content.type, 'Texto:', content.text);

    const db = await readDb();

    const convo = db.conversations[from] || {
      phone: from,
      status: 'BOT',
      step: 'ASK_NAME_COMPANY',
      messages: [],
      createdAt: nowIso()
    };

    let media = null;

    if (content.mediaId) {
      try {
        media = await downloadWhatsAppMedia(
          content.mediaId,
          from,
          content.type,
          content.filename
        );

        console.log('Archivo descargado:', media.url);
      } catch (err) {
        console.error('Error descargando archivo:', err.response?.data || err.message);
      }
    }

    convo.lastMessage = content.text;
    convo.updatedAt = nowIso();

    convo.messages.push({
      from: 'client',
      type: content.type,
      text: content.text,
      media,
      at: nowIso()
    });

    const c = classify(content.text);
    convo.tag = c.tag;

    if (c.wantsHuman) {
      convo.status = 'HUMAN';
    }

    if (convo.status === 'BOT') {
      let reply;

      if (content.type !== 'text') {
        reply = 'Recibimos el archivo adjunto ✅ Un operador lo revisará junto con la consulta.';
      } else {
        reply = nextBotReply(content.text, convo);
      }

      convo.messages.push({
        from: 'bot',
        type: 'text',
        text: reply,
        at: nowIso()
      });

      await sendWhatsAppText(from, reply);
    }

    db.conversations[from] = convo;
    await writeDb(db);

  } catch (e) {
    console.error('Webhook error:', e.response?.data || e.message);
  }
});

function requireDashboardAuth(req, res, next) {
  const pass = req.headers['x-dashboard-password'] || req.query.password;

  if (pass !== DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: 'Password incorrecto' });
  }

  next();
}

app.get('/api/conversations', requireDashboardAuth, async (req, res) => {
  const db = await readDb();

  const list = Object.values(db.conversations).sort((a, b) =>
    (b.updatedAt || '').localeCompare(a.updatedAt || '')
  );

  res.json(list);
});

app.post('/api/conversations/:phone/status', requireDashboardAuth, async (req, res) => {
  const db = await readDb();
  const phone = normalizePhone(req.params.phone);
  const convo = db.conversations[phone];

  if (!convo) {
    return res.status(404).json({ error: 'No existe conversación' });
  }

  convo.status = req.body.status === 'BOT' ? 'BOT' : 'HUMAN';
  convo.updatedAt = nowIso();

  await writeDb(db);

  res.json(convo);
});

app.post('/api/conversations/:phone/send', requireDashboardAuth, async (req, res) => {
  const db = await readDb();
  const phone = normalizePhone(req.params.phone);
  const text = (req.body.text || '').trim();

  if (!text) {
    return res.status(400).json({ error: 'Mensaje vacío' });
  }

  const convo = db.conversations[phone] || {
    phone,
    status: 'HUMAN',
    messages: [],
    createdAt: nowIso()
  };

  convo.status = 'HUMAN';

  convo.messages.push({
    from: 'human',
    type: 'text',
    text,
    at: nowIso()
  });

  convo.updatedAt = nowIso();
  db.conversations[phone] = convo;

  await sendWhatsAppText(phone, text);
  await writeDb(db);

  res.json(convo);
});

app.listen(PORT, () => {
  console.log(`Bot Carracedo listo en puerto ${PORT}`);
});
