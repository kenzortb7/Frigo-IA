import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import Stripe from 'stripe';
import nodemailer from 'nodemailer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Charge .env si présent
const __envPath = path.join(__dirname, '.env');
if (fs.existsSync(__envPath)) {
  fs.readFileSync(__envPath, 'utf8').split(/\r?\n/).forEach(line => {
    const idx = line.indexOf('=');
    if (idx > 0) process.env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  });
}
const PORT           = process.env.PORT || 3000;
const FRIGO_USER     = process.env.FRIGO_USER     || 'admin';
const FRIGO_PASSWORD = process.env.FRIGO_PASSWORD || 'frigo1234';
const SESSION_TOKEN  = process.env.SESSION_SECRET || (Math.random().toString(36).slice(2) + Date.now().toString(36));

function isAuth(req) {
  const token = (req.headers['x-token'] || '').trim();
  return token === SESSION_TOKEN || (token.startsWith('google_') && token.length > 14);
}
function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host  = req.headers['x-forwarded-host'] || req.headers['host'] || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

const mailer = (process.env.EMAIL_USER && process.env.EMAIL_PASS)
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
      tls: { rejectUnauthorized: false },
    })
  : null;

function buildExpiryEmail(items) {
  const rows = items.map(item => {
    const color = item.days === 0 ? '#F87171' : item.days === 1 ? '#FBBF24' : '#6EE7B7';
    const label = item.days === 0 ? '⚠️ Expire aujourd\'hui !'
                : item.days === 1 ? '⏰ Expire demain'
                : `⏳ Dans ${item.days} jour${item.days > 1 ? 's' : ''}`;
    return `
      <tr>
        <td style="padding:10px 14px;background:rgba(255,255,255,0.04);border-radius:10px;margin-bottom:6px;display:block">
          <span style="font-size:22px;vertical-align:middle;margin-right:10px">${item.emoji || '🥗'}</span>
          <strong style="font-size:14px;color:#EDE9E3;vertical-align:middle">${item.name}</strong>
          <span style="float:right;font-size:12px;color:${color};vertical-align:middle;margin-top:2px">${label}</span>
        </td>
      </tr>`;
  }).join('');
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:20px;background:#07070e;font-family:Arial,sans-serif">
  <div style="max-width:480px;margin:0 auto;background:#0C0C10;border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,0.08)">
    <div style="background:linear-gradient(135deg,#4F46E5,#6366F1,#818CF8);padding:28px 24px;text-align:center">
      <div style="font-size:36px;margin-bottom:8px">🧊</div>
      <h1 style="margin:0;font-size:22px;font-weight:700;color:#fff">Frigo IA</h1>
      <p style="margin:4px 0 0;color:rgba(255,255,255,0.7);font-size:13px">Alerte péremption</p>
    </div>
    <div style="padding:24px">
      <p style="margin:0 0 18px;font-size:15px;color:#EDE9E3">
        👋 Ces aliments dans ton frigo arrivent bientôt à expiration&nbsp;:
      </p>
      <table style="width:100%;border-collapse:separate;border-spacing:0 6px">${rows}</table>
      <div style="margin-top:20px;padding:14px 16px;background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.25);border-radius:12px">
        <p style="margin:0;font-size:13px;color:#a5b4fc">
          💡 Ouvre <strong>Frigo IA</strong> pour voir les recettes suggérées avec ces ingrédients avant qu'ils ne périment.
        </p>
      </div>
    </div>
    <div style="padding:14px 24px;border-top:1px solid rgba(255,255,255,0.06);text-align:center">
      <p style="margin:0;font-size:11px;color:#6E6A65">Frigo IA · Notifications automatiques · localhost:3000</p>
    </div>
  </div>
</body></html>`;
}

async function analyzeImage(base64, mediaType) {
  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: { url: `data:${mediaType};base64,${base64}`, detail: 'high' },
        },
        {
          type: 'text',
          text: `Analyse cette photo de réfrigérateur ou d'aliments et liste tous les aliments visibles.

Réponds UNIQUEMENT avec un tableau JSON valide, sans texte avant ou après, au format :
[{"name": "Tomates", "emoji": "🍅"}, {"name": "Lait", "emoji": "🥛"}]

Règles :
- Noms en français
- Sois précis et exhaustif
- Inclus tous les aliments visibles, même partiellement
- Utilise l'emoji le plus approprié pour chaque aliment`,
        },
      ],
    }],
  });

  const text = response.choices[0].message.content.trim();
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('Réponse invalide de l\'IA');
  return JSON.parse(match[0]);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

http.createServer(async (req, res) => {

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  // Endpoint Stripe — créer session de paiement
  if (req.method === 'POST' && req.url === '/create-checkout-session') {
    if (!stripe) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Stripe non configuré (STRIPE_SECRET_KEY manquante)' }));
      return;
    }
    try {
      const body  = JSON.parse(await readBody(req));
      const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email) ? body.email : undefined;
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
        mode: 'subscription',
        success_url: `${getBaseUrl(req)}/success.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url:  `${getBaseUrl(req)}/pricing.html`,
        ...(email ? { customer_email: email } : {}),
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ url: session.url }));
    } catch (err) {
      console.error('Erreur Stripe checkout :', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Endpoint Stripe — vérifier paiement
  if (req.method === 'GET' && req.url.startsWith('/verify-payment')) {
    if (!stripe) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ subscribed: false }));
      return;
    }
    try {
      const sessionId = new URL(req.url, `http://localhost`).searchParams.get('session_id');
      const session   = await stripe.checkout.sessions.retrieve(sessionId);
      const subscribed = session.status === 'complete' || session.payment_status === 'paid';
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ subscribed, email: session.customer_email || session.customer_details?.email || '' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ subscribed: false, error: err.message }));
    }
    return;
  }

  // Endpoint login
  if (req.method === 'POST' && req.url === '/login') {
    try {
      const body = JSON.parse(await readBody(req));
      if (body.username === FRIGO_USER && body.password === FRIGO_PASSWORD) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: true, token: SESSION_TOKEN }));
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: false, error: 'Identifiant ou mot de passe incorrect' }));
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // Endpoint analyse IA
  if (req.method === 'POST' && req.url === '/analyze') {
    if (!isAuth(req)) { res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: 'Non autorisé' })); return; }
    try {
      const body  = JSON.parse(await readBody(req));
      const items = await analyzeImage(body.base64 || body.image, body.mediaType);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ items }));
    } catch (err) {
      console.error('Erreur analyse :', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Endpoint recettes IA
  if (req.method === 'POST' && req.url === '/recipes') {
    if (!isAuth(req)) { res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: 'Non autorisé' })); return; }
    try {
      const body  = JSON.parse(await readBody(req));
      const foods = (body.foods || []).join(', ');
      const seed  = body.seed || Math.floor(Math.random() * 100000);
      const cuisines = ['française','italienne','asiatique','méditerranéenne','mexicaine','indienne','américaine','japonaise','marocaine','libanaise'];
      const styles   = ['rapide du soir','plat mijoté','repas healthy','comfort food','plat gastronomique','cuisine de bistrot','bowl nourrissant','plat familial'];
      const cuisine  = cuisines[seed % cuisines.length];
      const style    = styles[Math.floor(seed / 10) % styles.length];
      const response = await client.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 3000,
        temperature: 1.0,
        messages: [{
          role: 'user',
          content: `Tu es un chef étoilé créatif. Ingrédients dans le frigo : ${foods}.

Génère 3 VRAIES recettes du quotidien DIFFÉRENTES et variées (pas toujours omelette/salade/poêlée).
Inspiration du jour : cuisine ${cuisine}, style "${style}" (seed: ${seed}).

Sois CRÉATIF et VARIÉ : propose des plats authentiques avec de vrais noms (ex: Shakshuka, Pad Thaï, Gratin dauphinois, Ramen, Tajine, Risotto, etc.).
Adapte selon les ingrédients disponibles mais n'hésite pas à suggérer des plats inspirants.

Réponds UNIQUEMENT avec un tableau JSON valide, sans texte avant ou après :
[{
  "name": "Nom réel du plat",
  "emoji": "🍳",
  "time": "25 min",
  "difficulty": "Facile",
  "servings": 2,
  "nutrition": { "calories": 480, "proteins": 22, "carbs": 40, "fats": 18, "fiber": 5 },
  "ingredients": ["2 œufs battus", "1 tomate coupée en dés", "1 oignon émincé"],
  "steps": [
    "Faire revenir l'oignon dans l'huile d'olive à feu moyen pendant 3 minutes jusqu'à ce qu'il soit translucide.",
    "Ajouter la tomate et laisser compoter 5 minutes en remuant.",
    "Créer des puits et y casser les œufs. Couvrir et cuire 4 minutes à feu doux."
  ]
}]

Règles :
- Noms de plats RÉELS et connus (pas "Poêlée de légumes")
- Étapes très détaillées avec temps, températures, textures
- 4 à 6 étapes par recette
- Nutrition précise par portion
- Les 3 recettes doivent être très différentes (entrée/plat/autre type)`
        }],
      });
      const text  = response.choices[0].message.content.trim();
      const match = text.match(/\[[\s\S]*\]/);
      if (!match) throw new Error('Réponse invalide');
      const recipes = JSON.parse(match[0]);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ recipes }));
    } catch (err) {
      console.error('Erreur recettes :', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Endpoint génération image (gpt-image-1)
  if (req.method === 'POST' && req.url === '/generate-image') {
    if (!isAuth(req)) { res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: 'Non autorisé' })); return; }
    try {
      const body   = JSON.parse(await readBody(req));
      const prompt = `Ultra-realistic professional food photography of "${body.recipeName}", made with ${body.ingredients}. Perfect plating on elegant white ceramic plate, soft warm studio lighting, shallow depth of field bokeh, photorealistic 8K, appetizing, no text, no watermarks.`;
      const imgResponse = await client.images.generate({
        model: 'gpt-image-1',
        prompt,
        n: 1,
        size: '1024x1024',
        quality: 'standard',
      });
      const b64 = imgResponse.data[0].b64_json;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ b64 }));
    } catch (err) {
      console.error('Erreur image :', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Endpoint notifications email
  if (req.method === 'POST' && req.url === '/notify-expiry') {
    if (!mailer) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Email non configuré — ajoute EMAIL_USER et EMAIL_PASS dans .env' }));
      return;
    }
    try {
      const body  = JSON.parse(await readBody(req));
      const email = body.email;
      const items = body.items || [];
      if (!email) throw new Error('Email manquant');

      const now      = Date.now();
      const expiring = items
        .filter(f => f.expiry)
        .map(f => ({ ...f, days: Math.ceil((new Date(f.expiry) - now) / 86400000) }))
        .filter(f => f.days >= 0 && f.days <= 3)
        .sort((a, b) => a.days - b.days);

      if (expiring.length === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ sent: false, count: 0 }));
        return;
      }

      const plural  = expiring.length > 1;
      const subject = `🧊 Frigo IA — ${expiring.length} aliment${plural ? 's' : ''} ${plural ? 'arrivent' : 'arrive'} à expiration`;
      await mailer.sendMail({
        from: `"Frigo IA" <${process.env.EMAIL_USER}>`,
        to: email,
        subject,
        html: buildExpiryEmail(expiring),
      });
      console.log(`📧 Email envoyé à ${email} (${expiring.length} aliment${plural ? 's' : ''})`);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ sent: true, count: expiring.length }));
    } catch (err) {
      console.error('Erreur email :', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Fichiers statiques
  const pathname = new URL(req.url, 'http://localhost').pathname;
  let filePath = path.join(__dirname, pathname === '/' ? '/index.html' : pathname);
  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });

}).listen(PORT, () => {
  console.log(`Frigo IA → http://localhost:${PORT}`);
  if (!process.env.OPENAI_API_KEY) {
    console.warn('⚠  OPENAI_API_KEY non définie — analyse IA désactivée');
  }
});
