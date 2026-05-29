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

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(morgan('tiny'));
app.use(express.json({ limit: '2mb' }));
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

// CORRECCIÓN ARGENTINA:
// Meta a veces autoriza +54 11..., pero WhatsApp entrante llega como 54911...
// Esta función prueba enviar en formato autorizado por Meta.
function normalizePhoneForMeta(phone = '') {
  let clean = normalizePhone(phone);

  // Si viene como Argentina móvil: 54911XXXXXXXX
  // lo convertimos a: 5411XXXXXXXX
  if (clean.startsWith('54911')) {
    clean = '54' + clean.slice(3);
  }

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
  const lower = (text || '').toLowerCase();

  if (/operador|persona|humano|asesor|llamar/.test(lower)) {
    return 'Perfecto. Ya recibimos tu consulta ✅ Uno de nuestros operadores especializados continuará la atención a la brevedad.';
  }

  if (!convo.name || !convo.company) {
    return 'Hola 👋 Gracias por comunicarte con Estudio Carracedo Despachantes de Aduana. Para poder ayudarte mejor, ¿podrías indicarnos tu nombre y empresa?';
  }

  if (!convo.need) {
    return 'Perfecto. ¿Qué necesitás importar o exportar, desde qué país y en qué estado está la operación?';
  }

  if (!convo.hasSupplier) {
    return 'Gracias. ¿Ya tenés proveedor definido y factura/proforma, o todavía estás evaluando la operación?';
  }

  if (!convo.requiresAnmat) {
    return 'Una consulta más: ¿la mercadería requiere intervención de ANMAT o algún registro/certificado especial?';
  }

  return 'Gracias, ya tomamos los datos principales ✅ Un operador especializado revisará la consulta y continuará la atención a la brevedad.';
}

function updateExtractedFields(convo, text) {
  const clean = (text || '').trim();

  if (!convo.name && clean.length > 2) {
    const nameMatch = clean.match(/(?:soy|me llamo|mi nombre es)\s+([^,\.\n]+)/i);
    if (nameMatch) convo.name = nameMatch[1].trim();
  }

  if (!convo.company) {
    const companyMatch = clean.match(/(?:empresa|firma|compa[nñ][ií]a)\s+([^,\.\n]+)/i);
    if (companyMatch) convo.company = companyMatch[1].trim();
  }

  if ((!convo.name || !convo.company) && clean.includes('\n')) {
    const lines = clean.split('\n').map(x => x.trim()).filter(Boolean);
    if (!convo.name && lines[0]) convo.name = lines[0];
    if (!convo.company && lines[1]) convo.company = lines[1];
  }

  if (!convo.need && /import|export|traer|comprar|aduana|despacho|mercader[ií]a|producto|ncm|anmat/i.test(clean)) {
    convo.need = clean;
  }

  if (!convo.hasSupplier && /proveedor|proforma|factura|supplier/i.test(clean)) {
    convo.hasSupplier = clean;
  }

  if (!convo.requiresAnmat && /anmat|registro|certificado|m[eé]dic|salud|implante|quir/i.test(clean)) {
    convo.requiresAnmat = clean;
  }
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

    if (!message || message.type !== 'text') return;

    const from = normalizePhone(message.from);
    const text = message.text?.body || '';

    console.log('Mensaje recibido de:', from, 'Texto:', text);

    const db = await readDb();

    const convo = db.conversations[from] || {
      phone: from,
      status: 'BOT',
      messages: [],
      createdAt: nowIso()
    };

    convo.lastMessage = text;
    convo.updatedAt = nowIso();
    convo.messages.push({
      from: 'client',
      text,
      at: nowIso()
    });

    updateExtractedFields(convo, text);

    const c = classify(text);
    convo.tag = c.tag;

    if (c.wantsHuman) {
      convo.status = 'HUMAN';
    }

    if (convo.status === 'BOT') {
      const reply = nextBotReply(text, convo);

      convo.messages.push({
        from: 'bot',
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
