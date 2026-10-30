/* OSIRIS · Avisos por correo (Google Apps Script)
   Corre solo cada 10 minutos en tu cuenta de Google y te manda un correo cuando:
   - en un relevo no entró ningún guardia (30 min después del horario),
   - el guardia de turno lleva más de (rondas cada X h + 30 min) sin ronda,
   - un guardia pide adelanto o día libre, o escribe el monto que recibió,
   - toca descargar el respaldo del mes o las fotos llenan la nube.
   INSTALAR: pega este código, guarda, elige la función "instalar" y toca Ejecutar.
   Acepta los permisos (son de tu propia cuenta). Listo: queda funcionando solo. */

/* Correo que recibe los avisos. Vacío = el mismo correo de esta cuenta de Google. */
const CORREO_AVISOS = '';

function destino(){ return CORREO_AVISOS || Session.getEffectiveUser().getEmail(); }

/* fetch de la web hecho con UrlFetchApp (Apps Script no tiene fetch) */
function fetch(url, o){
  o = o || {};
  const h = Object.assign({}, o.headers || {}), tipo = h['Content-Type']; delete h['Content-Type'];
  const op = {method: (o.method || 'get').toLowerCase(), headers: h, muteHttpExceptions: true};
  if(o.body !== undefined){ op.payload = o.body; op.contentType = tipo || 'application/json'; }
  const r = UrlFetchApp.fetch(url, op);
  const c = r.getResponseCode(), t = r.getContentText();
  return {ok: c >= 200 && c < 300, status: c, text: () => t, json: () => JSON.parse(t)};
}

/* Instala la revisión automática cada 10 minutos (se puede ejecutar varias veces: no duplica) */
function instalar(){
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'revisarTodo').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('revisarTodo').timeBased().everyMinutes(10).create();
  MailApp.sendEmail(destino(), 'Osiris · Avisos activados', 'Desde ahora te llegan aquí los avisos de Osiris (cada 10 minutos se revisa): guardia que no entra al turno, ronda pendiente, pedidos de adelanto y día libre.');
  revisarTodo();
}

/* Prueba sin mandar correos: muestra en el registro lo que avisaría */
function probar(){ PRUEBA = true; try{ revisarTodo(); } finally { PRUEBA = false; } }

const SB = 'https://sxyxklzgjukokgvmxiif.supabase.co';
const KEY = 'sb_publishable_1sl0nTk6US5BygdM-_Zd0w_SIlGcLpp';
const MARGEN_MIN = 30;
const TZ = -4; // Bolivia, sin horario de verano
let AHORA = new Date();
let PRUEBA = false;

const H = {apikey: KEY, 'Content-Type': 'application/json'};
const api = q => { const r = fetch(`${SB}/rest/v1/${q}`, {headers: H}); if(!r.ok) throw new Error(`${r.status} ${r.text()}`); return r.json(); };
const enc = encodeURIComponent;
const det = e => { let d = e.detalle; if(typeof d === 'string'){ try{ d = JSON.parse(d); }catch(_){ d = {}; } } return d || {}; };
const hora = e => { const t = Date.parse(det(e).ts || e.created_at); return isNaN(t) ? new Date(e.created_at) : new Date(t); };
const local = d => new Date(d.getTime() + TZ * 3600e3); // reloj de Bolivia expresado en UTC
const hhmm = d => { const l = local(d); return String(l.getUTCHours()).padStart(2, '0') + ':' + String(l.getUTCMinutes()).padStart(2, '0'); };
const inList = a => 'in.(' + a.map(t => '"' + t + '"').join(',') + ')';

function avisosEnviados(){
  const desde = new Date(AHORA - 3 * 864e5).toISOString();
  const r = api(`eventos?select=detalle&tipo=eq.Config&edificio=eq.__monitor__&detalle->>clase=eq.alerta&created_at=gte.${enc(desde)}&limit=2000`);
  return new Set(r.map(e => det(e).clave));
}
function anotar(clave, texto){
  if(PRUEBA) return;
  const uid = 'alertas_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  fetch(`${SB}/rest/v1/eventos`, {method: 'POST', headers: {...H, Prefer: 'return=minimal'},
    body: JSON.stringify({tipo: 'Config', edificio: '__monitor__', guardia: 'Alertas', device_id: 'alertas', detalle: {clase: 'alerta', clave, texto, uid, ts: new Date().toISOString()}})});
}
function correo(asunto, texto){
  if(PRUEBA){ console.log('CORREO > ' + asunto + '\n    ' + texto); return true; }
  try{
    MailApp.sendEmail(destino(), asunto, texto + '\n\nHora: ' + hhmm(AHORA) + ' (Bolivia)\nMonitor: https://lucasquirozgainza-spec.github.io/SUPERVISION-OSIRIS/');
    return true;
  }catch(x){ console.error('No se pudo enviar el correo: ' + x.message); return false; }
}

function relevosDe(m){ const l = String(m.relevos || '').split(',').map(x => x.trim()).filter(x => /^\d\d:\d\d$/.test(x)); return l.length ? l : ['08:00', '20:00']; }
/* horarios de relevo (en hora real) entre hace 6 h y ahora - margen */
function relevosVencidos(lista){
  const out = [], l = local(AHORA);
  for(let dia = -1; dia <= 0; dia++) for(const h of lista){
    const [hh, mm] = h.split(':').map(Number);
    const t = new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate() + dia, hh, mm) - TZ * 3600e3);
    const pasado = (AHORA - t) / 60000;
    if(pasado >= MARGEN_MIN && pasado < 6 * 60) out.push(t);
  }
  return out;
}

function revisarEdificio(ed, m, enviados, conRondas){
  const desde = new Date(AHORA - 3 * 864e5).toISOString();
  const ev = api(`eventos?select=created_at,tipo,guardia,detalle&edificio=eq.${enc(ed)}&created_at=gte.${enc(desde)}`
    + `&tipo=${enc(inList(['Ingreso de turno', 'Salida de turno', 'Doblar turno', 'Ronda']))}&order=created_at.asc&limit=3000`);
  const bloqueDe = e => String(det(e).bloque || '');
  const salidas = new Set(ev.filter(e => e.tipo === 'Salida de turno').map(e => String(det(e).turno_ref || '')).filter(Boolean));
  const salidaHora = new Map(ev.filter(e => e.tipo === 'Salida de turno').map(e => [String(det(e).turno_ref || ''), hora(e)]));
  const nivel = new Map(ev.filter(e => e.tipo === 'Doblar turno').map(e => [String(det(e).turno_ref || ''), +det(e).nivel || 12]));
  const ingresos = ev.filter(e => e.tipo === 'Ingreso de turno');
  const bloques = [...new Set(ingresos.map(bloqueDe))];
  const cada = Math.min(12, Math.max(1, +m.ronda_cada || 2));
  const nombreB = b => ed + (b ? ' · ' + b : '');
  const avisos = [];

  for(const b of bloques){
    const ing = ingresos.filter(e => bloqueDe(e) === b);
    /* 1) relevos sin ingreso */
    for(const p of relevosVencidos(relevosDe(m))){
      const entro = ing.some(e => Math.abs(hora(e) - p) <= 3 * 3600e3);
      /* sigue alguien de turno que cubre ese relevo (dobló turno): no es falta */
      const cubre = ing.some(e => { const ref = String(det(e).turno_ref || ''); const ini = hora(e), n = nivel.get(ref) || 12;
        const sal = salidaHora.get(ref);
        return n > 12 && ini < p && +ini + n * 3600e3 > +p + MARGEN_MIN * 60000 && (!sal || sal > p); });
      if(!entro && !cubre){
        const clave = `ing|${ed}|${b}|${p.toISOString()}`;
        if(!enviados.has(clave)) avisos.push({clave, asunto: `Osiris · Sin ingreso en ${nombreB(b)}`,
          texto: `No se registró el ingreso del guardia en ${nombreB(b)} para el relevo de las ${hhmm(p)}.`});
      }
    }
    /* 2) guardia de turno sin ronda */
    if(!conRondas) continue;
    const abiertos = ing.filter(e => { const ref = String(det(e).turno_ref || ''); const n = nivel.get(ref) || 12;
      return ref && !salidas.has(ref) && AHORA - hora(e) < (n + 2) * 3600e3; });
    if(abiertos.length){
      const ini = new Date(Math.max(...abiertos.map(e => +hora(e))));
      const rondas = ev.filter(e => e.tipo === 'Ronda' && bloqueDe(e) === b && hora(e) >= new Date(+ini - 3600e3));
      const ultima = rondas.length ? new Date(Math.max(...rondas.map(e => +hora(e)))) : ini;
      const limite = new Date(+ultima + cada * 3600e3 + MARGEN_MIN * 60000);
      if(AHORA >= limite){
        const clave = `ronda|${ed}|${b}|${ultima.toISOString()}`;
        if(!enviados.has(clave)) avisos.push({clave, asunto: `Osiris · Ronda pendiente en ${nombreB(b)}`,
          texto: `${abiertos[abiertos.length - 1].guardia || 'El guardia de turno'} no registra ronda en ${nombreB(b)} desde las ${hhmm(ultima)} (rondas cada ${cada} h).`});
      }
    }
  }
  return avisos;
}

/* Pedidos de adelanto / día libre y montos de adelanto (últimos 2 días) */
/* Los franqueros NO pueden pedir adelantos ni días libres: su pedido se rechaza
   solo (al guardia le llega "no aprobado" en la app) y a supervisión no le llega nada. */
const MOTIVO_FRANQ = 'Los franqueros no pueden pedir adelantos ni días libres.';
const limpiarCi = v => String(v ?? '').trim().replace(/\s+/g, '').toUpperCase();   // igual que el monitor
function franqueros(){
  const r = api(`eventos?select=guardia,detalle,created_at&tipo=eq.Guardia&order=created_at.desc&limit=5000`);
  const ci = new Map(), nom = new Map();
  for(const e of r){
    const d = det(e), turno = String(d.turno || '').toUpperCase(), c = limpiarCi(d.ci), n = String(d.nombre || e.guardia || '').trim().toLowerCase();
    if(c && !ci.has(c)) ci.set(c, turno === 'FRANQUERO');
    if(n && !nom.has(n)) nom.set(n, turno === 'FRANQUERO');
  }
  return e => { const d = det(e), c = limpiarCi(d.guard_ci); return c && ci.has(c) ? ci.get(c) : nom.get(String(e.guardia || '').trim().toLowerCase()) === true; };
}
function rechazarFranquero(e){
  if(PRUEBA){ console.log('RECHAZO AUTOMÁTICO >', e.guardia, det(e).clase, det(e).sid); return; }
  const d = det(e), uid = 'alertas_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  fetch(`${SB}/rest/v1/eventos`, {method: 'POST', headers: {...H, Prefer: 'return=minimal'},
    body: JSON.stringify({tipo: 'Respuesta', edificio: e.edificio, guardia: 'Supervisión', device_id: 'alertas',
      detalle: {sid: String(d.sid), estado: 'rechazado', clase: d.clase, guardia: e.guardia, ci: d.guard_ci || '', fecha: d.fecha || '', motivo: MOTIVO_FRANQ, auto: true, uid, ts: new Date().toISOString()}})});
}
function revisarSolicitudes(enviados){
  const desde = new Date(AHORA - 2 * 864e5).toISOString();
  const ev = api(`eventos?select=created_at,edificio,guardia,detalle&tipo=eq.Solicitud&created_at=gte.${enc(desde)}&order=created_at.asc&limit=500`);
  const pedidos = new Map();
  const todos = api(`eventos?select=edificio,guardia,detalle&tipo=eq.Solicitud&created_at=gte.${enc(new Date(AHORA - 120 * 864e5).toISOString())}&limit=3000`);
  for(const e of todos){ const d = det(e); if(d.sid && (d.clase === 'adelanto' || d.clase === 'libre')) pedidos.set(String(d.sid), e); }
  const fechaTxt = ymd => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : (ymd || ''); };
  const esFranq = franqueros();
  const resp = api(`eventos?select=detalle&tipo=eq.Respuesta&created_at=gte.${enc(desde)}&limit=2000`);
  const respondidos = new Set(resp.map(r => String(det(r).sid || '')));
  const out = [];
  for(const e of ev){
    const d = det(e), sid = String(d.sid || ''); if(!sid) continue;
    const pedido = d.clase === 'monto' ? pedidos.get(sid) : e;
    if(pedido && esFranq(pedido)){
      if((d.clase === 'adelanto' || d.clase === 'libre') && !respondidos.has(sid)){ try{ rechazarFranquero(e); respondidos.add(sid); }catch(x){ console.error('rechazo', x.message); } }
      continue;   // a supervisión no le llega nada
    }
    const quien = e.guardia || 'Un guardia', ed = e.edificio + (d.bloque ? ' · ' + d.bloque : '');
    const motivo = d.motivo ? ` Motivo: ${d.motivo}.` : '';
    if(d.clase === 'adelanto'){
      const clave = 'sol|' + sid; if(enviados.has(clave)) continue;
      out.push({clave, asunto: `Osiris · ${quien} pide un adelanto`, texto: `${quien} (${ed}) pidió un adelanto a las ${hhmm(hora(e))}${d.fecha ? ' para el ' + fechaTxt(d.fecha) : ''}.${motivo} Apruébalo o recházalo en el monitor (Peticiones).`});
    } else if(d.clase === 'libre'){
      const clave = 'sol|' + sid; if(enviados.has(clave)) continue;
      out.push({clave, asunto: `Osiris · ${quien} pide día libre`, texto: `${quien} (${ed}) pidió día libre para el ${fechaTxt(d.fecha)}.${motivo} Apruébalo o recházalo en el monitor (Peticiones).`});
    } else if(d.clase === 'monto'){
      const clave = 'monto|' + sid + '|' + d.monto; if(enviados.has(clave)) continue;
      const p = pedidos.get(sid); const q = p ? (p.guardia || quien) : quien;
      out.push({clave, asunto: `Osiris · ${q} recibió Bs ${d.monto} de adelanto`, texto: `${q} (${ed}) escribió que recibió Bs ${d.monto} de adelanto. Confírmalo en el monitor (Peticiones) si es lo que le diste.`});
    }
  }
  return out;
}

/* Respaldo del mes y espacio de fotos (1 GB gratis) */
function listarFotos(prefix){
  const out = [];
  for(let off = 0; off < 200000; off += 1000){
    const r = fetch(`${SB}/storage/v1/object/list/osiris`, {method: 'POST', headers: H, body: JSON.stringify({prefix, limit: 1000, offset: off})});
    if(!r.ok) throw new Error('storage ' + r.status);
    const pg = r.json(); out.push(...pg); if(pg.length < 1000) break;
  }
  return out;
}
function revisarRespaldo(enviados){
  const out = [], l = local(AHORA);
  const ant = new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth() - 1, 1));
  const mesAnt = ant.getUTCFullYear() + '-' + String(ant.getUTCMonth() + 1).padStart(2, '0');
  const marcas = api(`eventos?select=detalle&tipo=eq.Config&edificio=eq.__monitor__&detalle->>clase=eq.respaldo&limit=500`);
  const hechos = new Set(marcas.map(e => det(e).mes));
  if(l.getUTCDate() <= 3 && !hechos.has(mesAnt) && !enviados.has('respaldo|' + mesAnt))
    out.push({clave: 'respaldo|' + mesAnt, asunto: `Osiris · Descarga el respaldo de ${mesAnt}`, texto: `Terminó el mes ${mesAnt}. En el monitor: Ajustes > Respaldo y espacio > Descargar, y súbelo a tu Google Drive. Después puedes liberar el espacio de las fotos de ese mes.`});
  const raiz = listarFotos('');
  let bytes = 0;
  for(const c of raiz.filter(x => !x.id)) for(const x of listarFotos(c.name + '/')) bytes += +(x.metadata && x.metadata.size) || 0;
  for(const x of raiz.filter(x => x.id)) bytes += +(x.metadata && x.metadata.size) || 0;
  const pct = bytes / (1024 ** 3) * 100, sem = 'espacio|' + l.toISOString().slice(0, 8) + (l.getUTCDate() <= 15 ? 'a' : 'b');
  if(pct >= 80 && !enviados.has(sem))
    out.push({clave: sem, asunto: `Osiris · Fotos en la nube al ${Math.round(pct)}%`, texto: `Las fotos ocupan ${(bytes / 1048576).toFixed(0)} MB de 1 GB. Descarga el respaldo del mes más antiguo y usa "Liberar" en Ajustes > Respaldo y espacio.`});
  return out;
}

function revisarTodo(){
  AHORA = new Date();
  const cfg = api(`eventos?select=edificio,detalle,created_at&tipo=eq.Config&edificio=neq.__monitor__&order=created_at.desc&limit=2000`);
  const ultima = new Map();
  for(const e of cfg){ if(!ultima.has(e.edificio)) ultima.set(e.edificio, e); }
  const enviados = avisosEnviados();
  let total = 0;
  for(const [ed, e] of ultima){
    let m = det(e).modulos; if(typeof m === 'string'){ try{ m = JSON.parse(m); }catch(_){ m = {}; } }
    if(!m || ed === '*' || ed.startsWith('__')) continue;
    if(m.alertas === false && m.alertas_ronda === false) continue;
    try{
      for(const a of revisarEdificio(ed, m, enviados, m.alertas_ronda !== false)){
        if(m.alertas === false && a.clave.startsWith('ing|')) continue;
        if(correo(a.asunto, a.texto)){ anotar(a.clave, a.texto); enviados.add(a.clave); total++; }
      }
    }catch(x){ console.error(ed, x.message); }
  }
  try{
    for(const a of revisarSolicitudes(enviados)){
      if(correo(a.asunto, a.texto)){ anotar(a.clave, a.texto); enviados.add(a.clave); total++; }
    }
  }catch(x){ console.error('solicitudes', x.message); }
  try{
    for(const a of revisarRespaldo(enviados)){
      if(correo(a.asunto, a.texto)){ anotar(a.clave, a.texto); enviados.add(a.clave); total++; }
    }
  }catch(x){ console.error('respaldo', x.message); }
  console.log(`Listo · ${total} aviso(s) · ${AHORA.toISOString()}`);
}
