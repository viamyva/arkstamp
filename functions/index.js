/**
 * ARKstamp Cloud Functions  –  functions/index.js
 * Firebase Functions v2  |  Node 22  |  Plain JS
 *
 * Functions:
 *   generateChapter  – AI suggestions / deck content generation
 *   analyzeDocument  – routes uploaded text/PDF docs to existing decks
 *   analyzeImage     – Claude Vision reads images (invitations, tickets, etc.)
 *   sendInviteEmail  – sends collaboration invite emails
 *   adminResolveUser – Ghost Mode: resolves UID from email (admin only)
 *   adminListUsers   – Ghost Mode: lists all Firebase Auth users (admin only)
 *
 * NOTE: The Anthropic client must be created inside each handler, not at module
 * load time. Firebase injects secrets into process.env only at invocation, not
 * when the module is first loaded, so a global `new Anthropic()` would receive
 * apiKey: undefined and silently fail on every call.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions');
const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

// Initialise firebase-admin at module load time — this is the correct pattern
// for Firebase Functions v2. getAuth() is then safe to call anywhere.
const admin = require('firebase-admin');
const { getAuth: getAdminAuth } = require('firebase-admin/auth');
admin.initializeApp();

const MODEL = 'claude-sonnet-4-6';
const ADMIN_EMAIL = 'edcrewguy@gmail.com';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function stripFences(text) {
  return text
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/gm, '')
    .trim();
}

function safeParseJSON(text, fallback) {
  const cleaned = stripFences(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch {}
    }
    return fallback;
  }
}

// Plain edit-distance helper, used to snap a handwriting read to the
// closest roster name when it isn't an exact match.
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d[m][n];
}

// Snaps a raw name reading to the closest roster name (case-insensitive,
// small edit distance). Returns null if nothing on the roster is close.
function snapToRoster(rawName, rosterNames) {
  const raw = rawName.trim().toLowerCase();
  const exact = rosterNames.find((n) => n.toLowerCase() === raw);
  if (exact) return exact;

  let best = null;
  let bestDist = Infinity;
  for (const n of rosterNames) {
    const dist = levenshtein(raw, n.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      best = n;
    }
  }
  const threshold = Math.max(1, Math.floor(raw.length * 0.3));
  return bestDist <= threshold ? best : null;
}

// ─────────────────────────────────────────────────────────────
// generateChapter
// ─────────────────────────────────────────────────────────────
exports.generateChapter = onCall(
  { region: 'us-central1', memory: '256MiB', timeoutSeconds: 60, secrets: ['ANTHROPIC_API_KEY'] },
  async (request) => {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const { prompt } = request.data || {};

    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new HttpsError('invalid-argument', 'prompt is required and must be a non-empty string');
    }

    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system:
        'You are a helpful life-planning assistant for ARKstamp. ' +
        'Always respond with valid JSON only — no markdown, no explanation, no preamble.',
      messages: [
        {
          role: 'user',
          content:
            prompt.trim() +
            '\n\nRespond with JSON in this exact format:\n' +
            '{"chapter":{"cards":[{"title":"Card Title","category":"Category","items":["item 1","item 2","item 3"]}]}}',
        },
      ],
    });

    const raw = message.content.find((b) => b.type === 'text')?.text || '';
    return safeParseJSON(raw, { chapter: { cards: [] } });
  }
);

// ─────────────────────────────────────────────────────────────
// analyzeDocument
// ─────────────────────────────────────────────────────────────
exports.analyzeDocument = onCall(
  { region: 'us-central1', memory: '256MiB', timeoutSeconds: 60, secrets: ['ANTHROPIC_API_KEY'] },
  async (request) => {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const { content, fileName, fileType, decks } = request.data || {};

    if (!content && !fileName) {
      throw new HttpsError('invalid-argument', 'content or fileName is required');
    }

    const deckList = Array.isArray(decks) ? decks : [];
    const deckContext =
      deckList.length > 0
        ? 'Available decks (match by id):\n' +
          deckList.map((d) => `  id="${d.id}" title="${d.title}"`).join('\n')
        : 'No existing decks.';

    const contentPreview = (typeof content === 'string' ? content : '').slice(0, 2500);

    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 512,
      system:
        'You are a document routing assistant for ARKstamp. ' +
        'Always respond with valid JSON only — no markdown.',
      messages: [
        {
          role: 'user',
          content:
            `Analyze this document and decide which existing decks it belongs in.\n\n` +
            `File name: ${fileName || 'unknown'}\n` +
            `File type: ${fileType || 'unknown'}\n` +
            `Content preview:\n${contentPreview}\n\n` +
            `${deckContext}\n\n` +
            `Respond with JSON:\n` +
            `{"suggestedDeckIds":["<id>","<id>"],"note":"one sentence describing what this document is"}`,
        },
      ],
    });

    const raw = message.content.find((b) => b.type === 'text')?.text || '';
    const parsed = safeParseJSON(raw, {});
    return {
      suggestedDeckIds: Array.isArray(parsed.suggestedDeckIds) ? parsed.suggestedDeckIds : [],
      note: typeof parsed.note === 'string' ? parsed.note : '',
    };
  }
);

// ─────────────────────────────────────────────────────────────
// analyzeImage
// ─────────────────────────────────────────────────────────────
exports.analyzeImage = onCall(
  { region: 'us-central1', memory: '512MiB', timeoutSeconds: 60, secrets: ['ANTHROPIC_API_KEY'] },
  async (request) => {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const { imageBase64, imageType = 'image/jpeg' } = request.data || {};

    if (!imageBase64 || typeof imageBase64 !== 'string') {
      throw new HttpsError('invalid-argument', 'imageBase64 is required');
    }

    const base64Data = imageBase64.includes(',')
      ? imageBase64.split(',')[1]
      : imageBase64;

    const validMediaTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    const mediaType = validMediaTypes.includes(imageType) ? imageType : 'image/jpeg';

    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 800,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: base64Data },
            },
            {
              type: 'text',
              text:
                'Read every word of text visible in this image carefully.\n' +
                'Respond with ONLY valid JSON — no markdown, no code blocks:\n' +
                '{"deckName":"3-5 word title for this event or document (e.g. Doug and Jen Wedding, Paris Trip June 2027, Team Offsite Austin)","note":"one concise sentence describing what this is","details":"all text extracted from the image, formatted clearly line by line"}',
            },
          ],
        },
      ],
    });

    const raw = message.content.find((b) => b.type === 'text')?.text || '';
    const parsed = safeParseJSON(raw, {});
    return {
      deckName: typeof parsed.deckName === 'string' ? parsed.deckName : '',
      note: typeof parsed.note === 'string' ? parsed.note : raw.slice(0, 200),
      details: typeof parsed.details === 'string' ? parsed.details : raw,
    };
  }
);

// ─────────────────────────────────────────────────────────────
// sendInviteEmail
// ─────────────────────────────────────────────────────────────
exports.sendInviteEmail = onCall(
  {
    region: 'us-central1',
    memory: '256MiB',
    timeoutSeconds: 30,
    secrets: ['EMAIL_USER', 'EMAIL_PASS'],
  },
  async (request) => {
    const { toEmail, toName, inviterEmail, deckTitle, role, tabAccess, expiresAt, ownerUid, chapterId } =
      request.data || {};

    if (!toEmail || typeof toEmail !== 'string') {
      throw new HttpsError('invalid-argument', 'toEmail is required');
    }

    const nodemailer = require('nodemailer');

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    const roleDescriptions = {
      viewer: 'view content',
      editor: 'view and edit content',
      admin: 'view, edit, and manage sharing',
    };

    const senderLabel = inviterEmail ? inviterEmail.split('@')[0] : 'A collaborator';
    const tabLine =
      tabAccess === 'all' || !Array.isArray(tabAccess)
        ? ''
        : `Tab access: ${tabAccess.join(', ')}\n`;
    const expiryLine = expiresAt
      ? `Access expires: ${new Date(expiresAt).toLocaleDateString('en-US', {
          month: 'long', day: 'numeric', year: 'numeric',
        })}\n`
      : '';

    const greeting = toName ? `Hi ${toName},` : 'Hi there,';
    const roleLabel = (role || 'viewer').charAt(0).toUpperCase() + (role || 'viewer').slice(1);
    const roleCap = roleDescriptions[role] || 'access this deck';

    const acceptUrl = (ownerUid && chapterId)
      ? `https://keepstamp-prod.web.app/?shared=1&owner=${ownerUid}&deck=${chapterId}`
      : 'https://keepstamp-prod.web.app';

    const body = [
      greeting, '',
      `${senderLabel} has shared the deck "${deckTitle}" with you on ARKstamp.`, '',
      `Role: ${roleLabel} -- you can ${roleCap}.`,
      tabLine ? tabLine.trim() : null,
      expiryLine ? expiryLine.trim() : null,
      '', `Open your shared deck: ${acceptUrl}`, '', '--', 'ARKstamp | keepstamp-prod.web.app',
    ].filter((l) => l !== null).join('\n');

    try {
      await transporter.sendMail({
        from: `ARKstamp <${process.env.EMAIL_USER}>`,
        to: toEmail,
        subject: `You have been invited to "${deckTitle}" on ARKstamp`,
        text: body,
      });
      return { sent: true };
    } catch (err) {
      console.error('[sendInviteEmail] failed:', err.message);
      return { sent: false, error: String(err.message) };
    }
  }
);

// ─────────────────────────────────────────────────────────────
// adminResolveUser
//
// Ghost Mode: resolves a Firebase UID from an email address.
// Only callable by edcrewguy@gmail.com.
// ─────────────────────────────────────────────────────────────
exports.adminResolveUser = onCall(
  { region: 'us-central1', memory: '256MiB', timeoutSeconds: 15 },
  async (request) => {
    if (request.auth?.token?.email !== ADMIN_EMAIL) {
      throw new HttpsError('permission-denied', 'Ghost access is restricted.');
    }

    const { email } = request.data || {};
    if (!email || typeof email !== 'string') {
      throw new HttpsError('invalid-argument', 'email is required');
    }

    try {
      const adminAuth = getAdminAuth();
      const userRecord = await adminAuth.getUserByEmail(email.trim().toLowerCase());
      return { uid: userRecord.uid, email: userRecord.email };
    } catch (err) {
      logger.error('[adminResolveUser] error:', err);
      if (err instanceof HttpsError) throw err;
      throw new HttpsError('not-found', `No account found for ${email}`);
    }
  }
);

// ─────────────────────────────────────────────────────────────
// adminListUsers
//
// Ghost Mode: returns all Firebase Auth users (uid + email + displayName).
// Only callable by edcrewguy@gmail.com.
// The frontend uses this to populate the ghost-mode user dropdown.
// ─────────────────────────────────────────────────────────────
exports.adminListUsers = onCall(
  { region: 'us-central1', memory: '256MiB', timeoutSeconds: 60 },
  async (request) => {
    // Enforce admin-only access
    if (request.auth?.token?.email !== ADMIN_EMAIL) {
      throw new HttpsError('permission-denied', 'Ghost access is restricted.');
    }

    try {
      const adminAuth = getAdminAuth();
      const users = [];
      let pageToken;

      do {
        const result = await adminAuth.listUsers(1000, pageToken);
        for (const u of result.users) {
          // Skip the admin account itself and accounts without an email
          if (u.email && u.email !== ADMIN_EMAIL) {
            users.push({
              uid: u.uid,
              email: u.email,
              displayName: u.displayName || null,
            });
          }
        }
        pageToken = result.pageToken;
      } while (pageToken);

      // Sort alphabetically by email for a clean dropdown experience
      users.sort((a, b) => a.email.localeCompare(b.email));

      logger.info(`[adminListUsers] returned ${users.length} users`);
      return { users };
    } catch (err) {
      logger.error('[adminListUsers] error:', err);
      if (err instanceof HttpsError) throw err;
      throw new HttpsError('internal', `Failed to list users: ${err.message}`);
    }
  }
);

// ─────────────────────────────────────────────────────────────
// executeCommand
//
// Global AI command bar — multi-tab edition.
// The frontend sends:
//   instruction  – raw natural-language string from the user
//   context      – {
//     deckTitle,
//     availableTabs: [{ tabId, tabName, template }],  // all custom tabs in this deck
//     activeTabId,   // currently visible tab (hint for ambiguous instructions)
//   }
//
// Claude returns an array of typed action objects, one per target tab.
// The frontend executes all Firestore writes and refreshes the UI.
// ─────────────────────────────────────────────────────────────
exports.executeCommand = onCall(
  { region: 'us-central1', memory: '512MiB', timeoutSeconds: 60, secrets: ['ANTHROPIC_API_KEY'] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in.');
    }

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const { instruction, context = {} } = request.data || {};

    if (!instruction || typeof instruction !== 'string' || !instruction.trim()) {
      throw new HttpsError('invalid-argument', 'instruction is required');
    }

    const {
      deckTitle = '',
      availableTabs = [],   // [{ tabId, tabName, template }]
      activeTabId = '',
    } = context;

    // Per-template item schemas (used in the prompt so Claude knows the shape)
    const templateSchemas = {
      timeline:  '{ "tabId": "<id>", "action": "add_items", "items": [{ "date": "YYYY-MM-DD", "title": "string", "description": "string (optional)" }] }',
      todo:      '{ "tabId": "<id>", "action": "add_items", "items": [{ "text": "string" }] }',
      shopping:  '{ "tabId": "<id>", "action": "add_items", "items": [{ "text": "string", "quantity": "string (optional)", "category": "one of: Produce,Dairy,Meat & Seafood,Bakery,Frozen,Beverages,Snacks,Pantry,Household,Personal Care,Other (optional)" }] }',
      contacts:  '{ "tabId": "<id>", "action": "add_items", "items": [{ "name": "string", "role": "string (optional)", "phone": "string (optional)", "email": "string (optional)" }] }',
      notes:     '{ "tabId": "<id>", "action": "add_note", "title": "string (optional, short label)", "text": "string" }',
      budget:    '{ "tabId": "<id>", "action": "add_items", "items": [{ "description": "string", "type": "expense|income", "amount": number, "category": "string (optional)", "date": "YYYY-MM-DD (optional)", "status": "unpaid|paid|estimated", "note": "string (optional)" }] }',
      links:     '{ "tabId": "<id>", "action": "add_items", "items": [{ "url": "string", "title": "string (optional)", "tag": "string (optional)", "note": "string (optional)" }] }',
      inventory: '{ "tabId": "<id>", "action": "add_items", "items": [{ "name": "string", "category": "string (optional)", "quantity": "string (optional)", "condition": "Excellent|Good|Fair|Poor (optional)", "location": "string (optional)", "value": "string (optional)", "notes": "string (optional)" }] }',
      eventlog:  '{ "tabId": "<id>", "action": "add_items", "items": [{ "date": "YYYY-MM-DD", "time": "HH:MM (optional)", "text": "string" }] }',
      itinerary: '{ "tabId": "<id>", "action": "add_items", "items": [{ "title": "string", "category": "flight|hotel|car|activity|transfer|note", "date": "string (optional)", "address": "string (optional)", "details": ["string"] }] }',
    };

    // Build a human-readable list of available tabs for the prompt
    const tabList = availableTabs.map((t) =>
      `  - tabId: "${t.tabId}"  name: "${t.tabName}"  template: ${t.template}`
    ).join('\n');

    // Build per-template schema reference
    const schemaRef = Object.entries(templateSchemas)
      .map(([tmpl, schema]) => `  ${tmpl}: ${schema}`)
      .join('\n');

    const activeTab = availableTabs.find((t) => t.tabId === activeTabId);
    const activeHint = activeTab
      ? `The user is currently viewing the "${activeTab.tabName}" tab (${activeTab.template}).`
      : '';

    const systemPrompt =
      'You are an AI assistant embedded in ARKstamp, a life-planning app. ' +
      'The user gives a natural-language instruction that may target one or more tabs. ' +
      'You must parse the instruction and return a JSON array of action objects, one per target tab. ' +
      'Always respond with valid JSON only — no markdown, no explanation, no preamble. ' +
      'Dates must be in YYYY-MM-DD format. If only a time is given (e.g. "4pm"), omit the date field. ' +
      'If the instruction mentions a tab by name or type, target that tab. ' +
      'If no tab is specified, target the currently active tab. ' +
      'Never include a tab in the output unless the instruction explicitly has content for it. ' +
      'If you cannot extract anything useful, return [{ "action": "none", "message": "explain why" }].';

    const userPrompt =
      `Deck: "${deckTitle}"\n` +
      `${activeHint}\n\n` +
      `Available tabs in this deck:\n${tabList || '  (none)'}\n\n` +
      `User instruction: ${instruction.trim()}\n\n` +
      `Return a JSON ARRAY where each element targets one tab. Use the tabId from the list above.\n` +
      `Each element must match the schema for its template:\n${schemaRef}\n\n` +
      `Example response for a multi-tab instruction:\n` +
      `[\n` +
      `  { "tabId": "abc123", "action": "add_items", "items": [{ "date": "2025-06-05", "title": "Dinner at Nobu" }] },\n` +
      `  { "tabId": "def456", "action": "add_items", "items": [{ "text": "eggs" }] }\n` +
      `]`;

    let message;
    try {
      message = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });
    } catch (err) {
      logger.error('[executeCommand] Anthropic error:', err);
      throw new HttpsError('internal', `AI service error: ${err.message}`);
    }

    const raw = message.content.find((b) => b.type === 'text')?.text || '';

    // Expect an array; fall back gracefully
    let parsed = safeParseJSON(raw, null);
    if (!Array.isArray(parsed)) {
      // Claude may have returned a single object — wrap it
      if (parsed && typeof parsed === 'object') {
        parsed = [parsed];
      } else {
        parsed = [{ action: 'none', message: 'Could not parse response.' }];
      }
    }
    return { actions: parsed };
  }
);

// ─────────────────────────────────────────────────────────────
// acceptSharedDeck
//
// Called by the recipient after clicking an invite link.
// Runs with admin privileges so it can read the owner's
// collaborator records without hitting Firestore security rules.
//
// Steps:
//   1. Verify the caller is authenticated.
//   2. Look up the collaborator record by email in the owner's chapter.
//   3. Mark the record status = 'active'.
//   4. Write a sharedDecks pointer under the recipient's own uid.
// ─────────────────────────────────────────────────────────────
exports.acceptSharedDeck = onCall(
  { region: 'us-central1', memory: '256MiB', timeoutSeconds: 30 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in to accept a share.');
    }

    const { ownerUid, chapterId } = request.data || {};
    if (!ownerUid || !chapterId) {
      throw new HttpsError('invalid-argument', 'ownerUid and chapterId are required.');
    }

    const callerUid   = request.auth.uid;
    const callerEmail = (request.auth.token.email || '').toLowerCase();

    if (ownerUid === callerUid) {
      return { status: 'self' }; // sharing with yourself is a no-op
    }

    const db = admin.firestore();
    const collabCol = db.collection(`users/${ownerUid}/chapters/${chapterId}/collaborators`);

    // Find the collaborator record whose email matches the caller
    const snap = await collabCol.where('email', '==', callerEmail).limit(1).get();
    if (snap.empty) {
      throw new HttpsError('not-found', 'No invitation found for this account.');
    }

    const collabDoc = snap.docs[0];

    // Mark active
    await collabDoc.ref.update({ status: 'active' });

    // Write a pointer under the recipient's own uid at a predictable doc id
    // so the Firestore security rule can use exists() to verify access.
    // Doc id format: ownerUid_chapterId
    const pointerDocId = `${ownerUid}_${chapterId}`;
    const pointerRef = db.doc(`users/${callerUid}/sharedDecks/${pointerDocId}`);
    // Include the role in the pointer doc so Firestore security rules can
    // enforce permissions without a second cross-document lookup.
    const role = collabDoc.data().role || 'editor';
    await pointerRef.set({
      ownerUid,
      chapterId,
      role,
      acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return { status: 'accepted' };
  }
);

// ─────────────────────────────────────────────────────────────
// updateSharedDeckRole
//
// Called by the deck owner when changing a collaborator's role.
// Updates the role field in the recipient's sharedDecks pointer doc
// so Firestore security rules immediately reflect the new level.
// ─────────────────────────────────────────────────────────────
exports.updateSharedDeckRole = onCall(
  { region: 'us-central1', memory: '256MiB', timeoutSeconds: 30 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in.');
    }

    const { collaboratorEmail, chapterId, newRole } = request.data || {};
    if (!collaboratorEmail || !chapterId || !newRole) {
      throw new HttpsError('invalid-argument', 'collaboratorEmail, chapterId, and newRole are required.');
    }

    const validRoles = ['viewer', 'editor', 'admin'];
    if (!validRoles.includes(newRole)) {
      throw new HttpsError('invalid-argument', `newRole must be one of: ${validRoles.join(', ')}`);
    }

    const ownerUid = request.auth.uid;
    const db = admin.firestore();

    try {
      const adminAuth = getAdminAuth();
      const userRecord = await adminAuth.getUserByEmail(collaboratorEmail.toLowerCase().trim());
      const recipientUid = userRecord.uid;

      const pointerDocId = `${ownerUid}_${chapterId}`;
      await db.doc(`users/${recipientUid}/sharedDecks/${pointerDocId}`).update({ role: newRole });

      return { status: 'updated' };
    } catch (err) {
      logger.warn('[updateSharedDeckRole] non-fatal:', err.message);
      return { status: 'not_found' };
    }
  }
);

// ─────────────────────────────────────────────────────────────
// revokeSharedDeck
//
// Called by the deck owner when removing a collaborator.
// Looks up the collaborator's Firebase UID by email, then
// deletes their sharedDecks pointer so the deck disappears
// from their library immediately.
// ─────────────────────────────────────────────────────────────
exports.revokeSharedDeck = onCall(
  { region: 'us-central1', memory: '256MiB', timeoutSeconds: 30 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in.');
    }

    const { collaboratorEmail, chapterId } = request.data || {};
    if (!collaboratorEmail || !chapterId) {
      throw new HttpsError('invalid-argument', 'collaboratorEmail and chapterId are required.');
    }

    const ownerUid = request.auth.uid;
    const db = admin.firestore();

    try {
      // Resolve the collaborator's UID from their email
      const adminAuth = getAdminAuth();
      const userRecord = await adminAuth.getUserByEmail(collaboratorEmail.toLowerCase().trim());
      const recipientUid = userRecord.uid;

      // Delete the sharedDecks pointer at the predictable path
      const pointerDocId = `${ownerUid}_${chapterId}`;
      await db.doc(`users/${recipientUid}/sharedDecks/${pointerDocId}`).delete();

      return { status: 'revoked' };
    } catch (err) {
      // If the user doesn't exist in Firebase Auth or the pointer doc doesn't exist,
      // that's fine — the access is already gone.
      logger.warn('[revokeSharedDeck] non-fatal:', err.message);
      return { status: 'not_found' };
    }
  }
);

// ─────────────────────────────────────────────────────────────
// migrateOverviewToTodo
//
// One-time migration callable.
// For every deck owned by the calling user that has docs in the
// `cards` subcollection, this function:
//   1. Finds or creates a customTab with template="todo" and name="To-do".
//   2. Reads each card doc. Checklist cards become individual To-do items.
//      Notes cards become a single item. Photo-only cards are skipped.
//   3. Writes items into
//      users/{uid}/chapters/{chapterId}/customTabs/{tabId}/items
//   Idempotent: if a todo tab already has items, that deck is skipped.
//
// Returns { migrated, skipped, empty }
// ─────────────────────────────────────────────────────────────
exports.migrateOverviewToTodo = onCall(
  { region: 'us-central1', memory: '512MiB', timeoutSeconds: 120 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in.');
    }

    const uid = request.auth.uid;
    const db = admin.firestore();

    const chaptersSnap = await db.collection(`users/${uid}/chapters`).get();
    if (chaptersSnap.empty) return { migrated: [], skipped: [], empty: [] };

    const migrated = [];
    const skipped = [];
    const empty = [];

    for (const chapterDoc of chaptersSnap.docs) {
      const chapterId = chapterDoc.id;
      const chapterTitle = chapterDoc.data().title || chapterId;

      // Read cards — plain get, no orderBy (avoids missing-field index errors)
      const cardsSnap = await db
        .collection(`users/${uid}/chapters/${chapterId}/cards`)
        .get();

      if (cardsSnap.empty) {
        empty.push({ chapterId, chapterTitle });
        continue;
      }

      const cards = cardsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const usableCards = cards.filter(c => {
        if (c.type === 'photo') return false;
        if (c.type === 'notes') return c.notesText && String(c.notesText).trim();
        return Array.isArray(c.items) && c.items.some(i => i.text && String(i.text).trim());
      });

      if (usableCards.length === 0) {
        empty.push({ chapterId, chapterTitle });
        continue;
      }

      // Find or create a To-do customTab
      const tabsRef = db.collection(`users/${uid}/chapters/${chapterId}/customTabs`);
      const existingTabsSnap = await tabsRef.where('template', '==', 'todo').limit(1).get();

      let tabId;
      let tabIsNew = false;
      if (!existingTabsSnap.empty) {
        tabId = existingTabsSnap.docs[0].id;
      } else {
        const allTabsSnap = await tabsRef.get();
        const maxOrder = allTabsSnap.docs.reduce((m, d) => Math.max(m, d.data().order ?? 0), -1);
        const newTabRef = await tabsRef.add({
          name: 'To-do',
          template: 'todo',
          order: maxOrder + 1,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        tabId = newTabRef.id;
        tabIsNew = true;
      }

      // Idempotent: skip if the tab already has items
      const itemsRef = db.collection(
        `users/${uid}/chapters/${chapterId}/customTabs/${tabId}/items`
      );
      const existingItemsSnap = await itemsRef.limit(1).get();
      if (!existingItemsSnap.empty) {
        skipped.push({ chapterId, chapterTitle, reason: 'tab already has items' });
        continue;
      }

      // Write items
      const batch = db.batch();
      let order = 0;
      let itemsAdded = 0;

      for (const card of usableCards) {
        if (card.type === 'notes') {
          const ref = itemsRef.doc();
          batch.set(ref, {
            text: (card.title ? card.title + ': ' : '') + String(card.notesText).trim(),
            completed: false,
            order: order++,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          itemsAdded++;
        } else {
          const validItems = (card.items || []).filter(i => i.text && String(i.text).trim());
          for (const item of validItems) {
            const ref = itemsRef.doc();
            batch.set(ref, {
              text: String(item.text).trim(),
              completed: item.completed ?? false,
              order: order++,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            itemsAdded++;
          }
        }
      }

      await batch.commit();
      migrated.push({ chapterId, chapterTitle, itemsAdded, tabId, tabIsNew });
    }

    return { migrated, skipped, empty };
  }
);
// ─────────────────────────────────────────────────────────────
// readLunchBoard
//
// Reads a photo of the classroom clothespin lunch-count board and
// sorts each clothespin name into the correct line for the paper
// tally form.
//
// Board layout: two rows (Breakfast / No Breakfast) by however
// many columns the teacher has configured (the lunch choices).
// The paper form only has: Breakfast, Milk, then one line per
// column that is marked to appear on the form.
//
// Mapping rules:
//   - Breakfast line gets every name in the board's Breakfast
//     row, regardless of which column it sits under
//   - Each lunch-choice line gets every name under that column,
//     combining both the Breakfast row and the No Breakfast row
//   - Milk is never read from the board, it always starts empty
//   - A column marked as not included on the form (for example
//     Brought from Home) is dropped entirely
//
// If a class roster (name + clothespin color) is provided, it is
// given to the model as a closed set of valid names plus their
// known colors, so a shaky handwriting read on a pin of a known
// color can be resolved with much higher confidence. Every name
// that comes back is then snapped to the closest roster name
// server-side (exact match first, then small edit distance);
// anything that doesn't land close to any roster name is moved to
// unresolved instead of being placed on the form.
// ─────────────────────────────────────────────────────────────
exports.readLunchBoard = onCall(
  { region: 'us-central1', memory: '512MiB', timeoutSeconds: 60, secrets: ['ANTHROPIC_API_KEY'] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in.');
    }

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const { imageBase64, imageType = 'image/jpeg', columns, roster } = request.data || {};

    if (!imageBase64 || typeof imageBase64 !== 'string') {
      throw new HttpsError('invalid-argument', 'imageBase64 is required');
    }
    if (!Array.isArray(columns) || columns.length === 0) {
      throw new HttpsError('invalid-argument', 'columns is required');
    }

    const base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
    const validMediaTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    const mediaType = validMediaTypes.includes(imageType) ? imageType : 'image/jpeg';

    const includedColumns = columns.filter((c) => c.includeOnForm).map((c) => c.name);
    const allColumnNames = columns.map((c) => c.name);

    const rosterList = Array.isArray(roster)
      ? roster.filter((r) => r && typeof r.name === 'string' && r.name.trim())
      : [];
    const rosterNames = rosterList.map((r) => r.name.trim());

    const rosterBlock =
      rosterList.length > 0
        ? 'This class roster tells you every valid student name and the color of that ' +
          "student's clothespin. Use the pin's color together with the handwriting to decide " +
          'which roster name it is, especially when the handwriting is hard to read. Only use ' +
          'names from this roster, do not invent a name that is not listed:\n' +
          rosterList.map((r) => `  - ${r.name.trim()} (${r.color || 'unknown color'})`).join('\n') +
          '\n\n'
        : '';

    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1500,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: base64Data },
            },
            {
              type: 'text',
              text:
                'This is a photo of a classroom lunch count board. It has two rows, labeled ' +
                '"Breakfast" and "No Breakfast" (or similar wording), going down the left side, ' +
                `and these columns going across the top, in this order: ${allColumnNames.join(', ')}.\n\n` +
                'Each clothespin has a student name written on it by hand, and its position on ' +
                'the board tells you its row and column. Read every clothespin on the board.\n\n' +
                rosterBlock +
                'If a pin is clearly inside a grid cell, report its row and column. If a pin sits ' +
                'in an ambiguous spot, off the grid lines, or is hard to place, still give your ' +
                'best guess for row and column, but also list it separately under unresolved ' +
                'with a short reason.\n\n' +
                'Respond with ONLY valid JSON, no markdown, no code fences:\n' +
                '{"pins":[{"name":"...","color":"...","row":"Breakfast or No Breakfast","column":"..."}],' +
                '"unresolved":[{"name":"...","reason":"..."}]}',
            },
          ],
        },
      ],
    });

    const raw = message.content.find((b) => b.type === 'text')?.text || '';
    const parsed = safeParseJSON(raw, { pins: [], unresolved: [] });
    const rawPins = Array.isArray(parsed.pins) ? parsed.pins : [];
    const unresolved = Array.isArray(parsed.unresolved) ? [...parsed.unresolved] : [];

    // Snap each pin's name to the roster (if one was supplied) before
    // sorting into rows, so a slightly-off handwriting read still lands
    // on the right line instead of creating a near-duplicate name.
    const pins = [];
    for (const pin of rawPins) {
      if (!pin || typeof pin.name !== 'string' || !pin.name.trim()) continue;
      let name = pin.name.trim();

      if (rosterNames.length > 0) {
        const snapped = snapToRoster(name, rosterNames);
        if (snapped) {
          name = snapped;
        } else {
          unresolved.push({ name, reason: 'not a clear match on the roster' });
          continue;
        }
      }

      pins.push({ ...pin, name });
    }

    const rows = { Breakfast: [], Milk: [] };
    for (const col of includedColumns) rows[col] = [];

    for (const pin of pins) {
      const name = pin.name;
      const rowText = String(pin.row || '').toLowerCase();
      const isBreakfast = rowText.includes('breakfast') && !rowText.includes('no breakfast');

      if (isBreakfast && !rows.Breakfast.includes(name)) rows.Breakfast.push(name);

      const matchedCol = includedColumns.find(
        (c) => c.toLowerCase().trim() === String(pin.column || '').toLowerCase().trim()
      );
      if (matchedCol && !rows[matchedCol].includes(name)) rows[matchedCol].push(name);
    }

    return { rows, unresolved };
  }
);

// ─────────────────────────────────────────────────────────────
// generateLunchCountPdf
//
// Builds the filled-in lunch count PDF from the reviewed table
// and saves it to Storage under the caller's own folder, plus a
// Firestore record so it shows up in the user's history list.
// Uses the same download token pattern as client uploadBytes /
// getDownloadURL, so no Storage rule changes are needed.
// ─────────────────────────────────────────────────────────────
async function buildLunchCountPdf({ headerLine1, headerLine2, rowOrder, rows }) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const pageWidth = 612;
  const margin = 40;
  const tableWidth = pageWidth - margin * 2;
  const col1Width = 150;
  const col3Width = 60;
  const col2Width = tableWidth - col1Width - col3Width;
  const headerRowHeight = 40;
  const lineHeight = 12;
  const minRowHeight = 24;
  const cellPadding = 6;

  function wrapNames(names) {
    const text = (names || []).join(', ');
    if (!text) return [''];
    const words = text.split(' ');
    const lines = [];
    let current = '';
    const maxWidth = col2Width - cellPadding * 2;
    for (const word of words) {
      const test = current ? current + ' ' + word : word;
      if (font.widthOfTextAtSize(test, 10) > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);
    return lines;
  }

  const rowHeights = rowOrder.map((label) => {
    const lines = wrapNames(rows[label]);
    return Math.max(minRowHeight, lines.length * lineHeight + cellPadding * 2);
  });

  const tableHeight = headerRowHeight + rowHeights.reduce((a, b) => a + b, 0);
  const page = doc.addPage([pageWidth, tableHeight + margin * 2]);

  let y = page.getHeight() - margin;
  const x0 = margin;

  page.drawRectangle({
    x: x0, y: y - headerRowHeight, width: tableWidth, height: headerRowHeight,
    color: rgb(0.95, 0.95, 0.95), borderColor: rgb(0, 0, 0), borderWidth: 1,
  });
  page.drawLine({ start: { x: x0 + col1Width, y }, end: { x: x0 + col1Width, y: y - headerRowHeight }, thickness: 1, color: rgb(0, 0, 0) });
  page.drawLine({ start: { x: x0 + col1Width + col2Width, y }, end: { x: x0 + col1Width + col2Width, y: y - headerRowHeight }, thickness: 1, color: rgb(0, 0, 0) });

  page.drawText(headerLine1 || '', { x: x0 + cellPadding, y: y - 16, size: 11, font: fontBold });
  page.drawText(headerLine2 || '', { x: x0 + cellPadding, y: y - 30, size: 11, font: fontBold });

  const studentsLabel = "Student's Name";
  const studentsWidth = fontBold.widthOfTextAtSize(studentsLabel, 12);
  page.drawText(studentsLabel, { x: x0 + col1Width + (col2Width - studentsWidth) / 2, y: y - headerRowHeight / 2 - 5, size: 12, font: fontBold });

  const totalLabel = 'Total';
  const totalWidth = fontBold.widthOfTextAtSize(totalLabel, 12);
  page.drawText(totalLabel, { x: x0 + col1Width + col2Width + (col3Width - totalWidth) / 2, y: y - headerRowHeight / 2 - 5, size: 12, font: fontBold });

  y -= headerRowHeight;

  rowOrder.forEach((label, i) => {
    const h = rowHeights[i];
    const names = rows[label] || [];
    const lines = wrapNames(names);

    page.drawRectangle({ x: x0, y: y - h, width: tableWidth, height: h, borderColor: rgb(0, 0, 0), borderWidth: 1 });
    page.drawLine({ start: { x: x0 + col1Width, y }, end: { x: x0 + col1Width, y: y - h }, thickness: 1, color: rgb(0, 0, 0) });
    page.drawLine({ start: { x: x0 + col1Width + col2Width, y }, end: { x: x0 + col1Width + col2Width, y: y - h }, thickness: 1, color: rgb(0, 0, 0) });

    page.drawText(String(label).toUpperCase(), { x: x0 + cellPadding, y: y - 15, size: 10, font });

    lines.forEach((line, li) => {
      page.drawText(line, { x: x0 + col1Width + cellPadding, y: y - cellPadding - lineHeight * (li + 1) + 2, size: 10, font });
    });

    const total = names.length ? String(names.length) : '';
    const totalW = font.widthOfTextAtSize(total, 10);
    page.drawText(total, { x: x0 + col1Width + col2Width + (col3Width - totalW) / 2, y: y - h / 2 - 4, size: 10, font });

    y -= h;
  });

  return doc.save();
}

exports.generateLunchCountPdf = onCall(
  { region: 'us-central1', memory: '256MiB', timeoutSeconds: 60 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in.');
    }

    const uid = request.auth.uid;
    const { date, headerLine1, headerLine2, rowOrder, rows } = request.data || {};

    if (!date || typeof date !== 'string') {
      throw new HttpsError('invalid-argument', 'date is required (YYYY-MM-DD)');
    }
    if (!Array.isArray(rowOrder) || rowOrder.length === 0 || !rows || typeof rows !== 'object') {
      throw new HttpsError('invalid-argument', 'rowOrder and rows are required');
    }

    const pdfBytes = await buildLunchCountPdf({ headerLine1, headerLine2, rowOrder, rows });

    const bucket = admin.storage().bucket();
    const filePath = `users/${uid}/lunchCounts/${date}.pdf`;
    const file = bucket.file(filePath);
    const token = crypto.randomUUID();

    await file.save(Buffer.from(pdfBytes), {
      metadata: {
        contentType: 'application/pdf',
        metadata: { firebaseStorageDownloadTokens: token },
      },
    });

    const url =
      `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/` +
      `${encodeURIComponent(filePath)}?alt=media&token=${token}`;

    const db = admin.firestore();
    await db.doc(`users/${uid}/lunchCounts/${date}`).set(
      {
        date,
        pdfUrl: url,
        rows,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return { url, date };
  }
);
