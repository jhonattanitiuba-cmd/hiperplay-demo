/*
 * rastreio.js — rastreamento da loja, num lugar só.
 * Incluído no <head> de todas as páginas, ANTES dos scripts delas.
 *
 * A venda da Hiper Play fecha no WhatsApp, fora do site. Para saber qual anúncio
 * trouxe a venda, a origem do clique precisa atravessar a conversa:
 *
 *   anúncio (?gclid / ?fbclid) → loja guarda + gera código de 6 letras
 *   → código vai na "Ref:" da mensagem do WhatsApp → SARAH lê o código
 *   → sistema acha o clique → orçamento/venda carregam a origem
 *   → sistema devolve a conversão ao Google (CSV) e à Meta (API de Conversões).
 *
 * O gclid/fbclid NUNCA entra na mensagem: tem ~90+ caracteres e o cliente lê a
 * mensagem antes de enviar; aquilo ali gera desconfiança e ele apaga. Vai só o
 * código curto, que parece um número de protocolo comum.
 *
 * Este arquivo:
 *   - captura gclid/gbraid/wbraid (Google) e fbclid (Meta) da URL;
 *   - grava os cookies _fbp/_fbc no formato da Meta (o Pixel reaproveita);
 *   - carrega o Pixel da Meta, se HPR_PIXEL_ID estiver preenchido;
 *   - registra pageview e clique no WhatsApp no pixel interno (/api/px);
 *   - intercepta TODA saída para o WhatsApp (link ou window.open) e garante o
 *     código na Ref. Antes, cada página fazia isso à mão, e o /catalogo não fazia.
 *
 * Globais que as páginas usam: lerClique, registrarClique, comCodigo, px, hpEvento.
 */

// ID do Pixel da Meta (Gerenciador de Eventos → fonte de dados). Vazio = Pixel
// desligado; o resto do rastreio (Google, pixel interno, código) segue funcionando.
var HPR_PIXEL_ID = '';

var HPR_API = 'https://app.hiperplay.com.br';
var HPR_CHAVE = 'hp_clique';
// O Google descarta gclid com mais de 90 dias; a Meta, fbclid com mais de 90 também.
var HPR_VALIDADE = 90 * 24 * 60 * 60 * 1000;
// Sem I, L, O, 0 e 1: um dia alguém vai ler este código em voz alta.
var HPR_ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function novoCodigo() {
  var b = new Uint8Array(6);
  (window.crypto || window.msCrypto).getRandomValues(b);
  var s = '';
  for (var i = 0; i < 6; i++) s += HPR_ALFABETO[b[i] % HPR_ALFABETO.length];
  return s;
}

// ===== cookies da Meta =====
// _fbp identifica o navegador; _fbc, o clique no anúncio. O Pixel reaproveita os
// que já existem, então gravar aqui deixa navegador e servidor com o MESMO valor,
// que é o que a API de Conversões usa para casar o evento com o clique.
function lerCookie(nome) {
  var m = document.cookie.match(new RegExp('(?:^|; )' + nome + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}
function gravarCookie(nome, valor) {
  var dominio = /(^|\.)hiperplay\.com\.br$/.test(location.hostname) ? '; domain=.hiperplay.com.br' : '';
  var seguro = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = nome + '=' + encodeURIComponent(valor) + '; max-age=' + (90 * 86400) + '; path=/; SameSite=Lax' + dominio + seguro;
}
(function cookiesMeta() {
  try {
    if (!lerCookie('_fbp')) gravarCookie('_fbp', 'fb.1.' + Date.now() + '.' + Math.floor(1e9 + Math.random() * 9e9));
    var fbclid = new URLSearchParams(location.search).get('fbclid');
    if (fbclid) gravarCookie('_fbc', 'fb.1.' + Date.now() + '.' + fbclid);
  } catch (e) {}
})();

// ===== clique de anúncio =====
function lerClique() {
  try {
    var r = JSON.parse(localStorage.getItem(HPR_CHAVE) || 'null');
    if (!r || !r.cod) return null;
    if (Date.now() - (r.ts || 0) > HPR_VALIDADE) { localStorage.removeItem(HPR_CHAVE); return null; }
    return r;
  } catch (e) { return null; }
}
(function capturarClique() {
  try {
    var q = new URLSearchParams(location.search);
    // gbraid/wbraid vêm no lugar do gclid em iPhone com restrição de rastreio.
    var gclid = q.get('gclid'), gbraid = q.get('gbraid'), wbraid = q.get('wbraid'), fbclid = q.get('fbclid');
    if (!gclid && !gbraid && !wbraid && !fbclid) return;
    // Clique novo vence o anterior (last-click).
    localStorage.setItem(HPR_CHAVE, JSON.stringify({
      cod: novoCodigo(), gclid: gclid, gbraid: gbraid, wbraid: wbraid, fbclid: fbclid,
      ts: Date.now(), camp: q.get('utm_campaign') || null, enviado: false
    }));
  } catch (e) {}
})();

/** Manda o par código→clique para o sistema. Best-effort: tenta de novo depois. */
function registrarClique() {
  var r = lerClique();
  if (!r || r.enviado) return;
  fetch(HPR_API + '/api/ads/click', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cod: r.cod, gclid: r.gclid, gbraid: r.gbraid, wbraid: r.wbraid,
      fbclid: r.fbclid, fbc: lerCookie('_fbc'), fbp: lerCookie('_fbp'), camp: r.camp
    }),
    keepalive: true
  }).then(function (res) {
    if (res.ok) { r.enviado = true; try { localStorage.setItem(HPR_CHAVE, JSON.stringify(r)); } catch (e) {} }
  }).catch(function () {});
}

/** Acrescenta o código à Ref que a mensagem já tem. */
function comCodigo(ref) {
  var r = lerClique();
  return r ? ref + '-' + r.cod : ref;
}

// ===== Pixel da Meta =====
(function pixelMeta() {
  if (!HPR_PIXEL_ID) return;
  !function (f, b, e, v, n, t, s) {
    if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
    if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = [];
    t = b.createElement(e); t.async = !0; t.src = v;
    s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
  }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
  window.fbq('init', HPR_PIXEL_ID);
  window.fbq('track', 'PageView');
})();

/** Evento padrão da Meta. No-op com o Pixel desligado. */
function hpEvento(nome, params) {
  try { if (window.fbq) window.fbq('track', nome, params || {}); } catch (e) {}
}

/** "R$ 4.000,00" → 4000. Para o value dos eventos. */
function hpValor(preco) {
  var n = parseFloat(String(preco || '').replace(/[^\d,]/g, '').replace(',', '.'));
  return isFinite(n) ? n : undefined;
}

// ===== pixel interno (funil first-party, dentro da plataforma) =====
function px(evt) {
  try {
    var r = lerClique();
    var camp = new URLSearchParams(location.search).get('utm_campaign') || (r && r.camp) || null;
    fetch(HPR_API + '/api/px', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ evt: evt, cod: r && r.cod, camp: camp, path: location.pathname }),
      keepalive: true
    }).catch(function () {});
  } catch (e) {}
  // Clique no WhatsApp é o último passo que o navegador vê: vira Contact na Meta.
  // Lead e Purchase NÃO saem daqui; quem sabe deles é o servidor (src/lib/capi.ts).
  if (evt === 'whatsapp_click') hpEvento('Contact');
}

// ===== toda saída para o WhatsApp passa por aqui =====
// O slug termina em letra/número: o "_" logo depois é o fim do itálico do WhatsApp
// ("_Origem: ... Ref: HP-BALANCA_"), e engoli-lo quebrava a formatação.
var HPR_REF = /(Ref:\s*)(HP-[A-Z0-9_]{0,29}[A-Z0-9])(?!-[A-Z2-9]{6})/;

/** Garante o código do clique no texto da mensagem. Devolve a URL ajustada. */
function hprMarcar(url) {
  var r = lerClique();
  if (!r) return url;
  try {
    var u = new URL(url, location.href);
    var t = u.searchParams.get('text') || '';
    if (t.indexOf(r.cod) >= 0) return url;                  // já tem (comCodigo)
    if (HPR_REF.test(t)) t = t.replace(HPR_REF, '$1$2-' + r.cod); // Ref do produto sem código
    else t = t + (t ? '\n\n' : '') + '_Ref: ' + r.cod + '_';  // link fixo sem Ref
    u.searchParams.set('text', t);
    return u.toString();
  } catch (e) { return url; }
}
function hprSaida() {
  registrarClique(); // última chance antes de a SARAH receber um código que ninguém conhece
  px('whatsapp_click');
}
var hprEhWhats = function (url) { return /(^|\/\/)(wa\.me|api\.whatsapp\.com)\//.test(String(url || '')); };

// Links: fase de captura, antes de o navegador seguir o href.
document.addEventListener('click', function (e) {
  var a = e.target && e.target.closest && e.target.closest('a[href]');
  if (!a || !hprEhWhats(a.href)) return;
  a.href = hprMarcar(a.href);
  hprSaida();
}, { capture: true });

// window.open: checkout, promoção e institucional abrem o WhatsApp por aqui.
(function () {
  var abrir = window.open;
  window.open = function (url) {
    if (hprEhWhats(url)) {
      arguments[0] = hprMarcar(url);
      hprSaida();
    }
    return abrir.apply(window, arguments);
  };
})();

// Ao carregar: tenta registrar o clique e conta a visita.
registrarClique();
px('pageview');
