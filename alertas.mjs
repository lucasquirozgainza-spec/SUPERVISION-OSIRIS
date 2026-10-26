// Osiris · avisos por correo (corre en GitHub Actions cada 15 minutos).
// Manda al correo de Osiris (el mismo de los formularios de la página web):
//  - si en un relevo no entró ningún guardia (30 min después del horario).
//    Activo en TODOS los edificios salvo que en el monitor se desmarque.
//  - si un guardia de turno lleva más de (rondas cada X h + 30 min) sin ronda
//    (solo en los edificios con "Avisarme si falta una ronda" marcado).
//  - cada pedido de adelanto o de día libre, y cada monto de adelanto que un
//    guardia escribe (para confirmarlo en el monitor).
// Cada aviso se manda una sola vez (queda anotado en la nube).

const SB = process.env.SB_URL || 'https://idwsbukgtogiwvfrurlc.supabase.co';
const KEY = process.env.SB_KEY || 'sb_publishable_-uuIV9H6rYYWjhyGNNtQww_0oww_OyF';
const FORM = process.env.FORM_TOKEN || '3b28ce9c5e25dfe592b336c8d4829a54';
const SITIO = process.env.SITIO || 'https://osirissecurity.com.bo/';
const MARGEN_MIN = 30;
const TZ = -4; // Bolivia, sin horario de verano
const AHORA = process.env.AHORA ? new Date(process.env.AHORA) : new Date();
const PRUEBA = process.env.PRUEBA === '1';

const H = {apikey: KEY, 'Content-Type': 'application/json'};
const api = async q => { const r = await fetch(`${SB}/rest/v1/${q}`, {headers: H}); if(!r.ok) throw new Error(`${r.status} ${await r.text()}`); return r.json(); };
const enc = encodeURIComponent;
const det = e => { let d = e.detalle; if(typeof d === 'string'){ try{ d = JSON.parse(d); }catch(_){ d = {}; } } return d || {}; };
const hora = e => { const t = Date.parse(det(e).ts || e.created_at); return isNaN(t) ? new Date(e.created_at) : new Date(t); };
const local = d => new Date(d.getTime() + TZ * 3600e3); // reloj de Bolivia expresado en UTC
const hhmm = d => { const l = local(d); return String(l.getUTCHours()).padStart(2, '0') + ':' + String(l.getUTCMinutes()).padStart(2, '0'); };
const inList = a => 'in.(' + a.map(t => '"' + t + '"').join(',') + ')';

async function avisosEnviados(){
  const desde = new Date(AHORA - 3 * 864e5).toISOString();
  const r = await api(`eventos?select=detalle&tipo=eq.Config&edificio=eq.__monitor__&detalle->>clase=eq.alerta&created_at=gte.${enc(desde)}&limit=2000`);
  return new Set(r.map(e => det(e).clave));
}
async function anotar(clave, texto){
  if(PRUEBA) return;
  const uid = 'alertas_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  await fetch(`${SB}/rest/v1/eventos`, {method: 'POST', headers: {...H, Prefer: 'return=minimal'},
    body: JSON.stringify({tipo: 'Config', edificio: '__monitor__', guardia: 'Alertas', device_id: 'alertas', detalle: {clase: 'alerta', clave, texto, uid, ts: new Date().toISOString()}})});
}
async function correo(asunto, texto){
  if(PRUEBA){ console.log('CORREO >', asunto, '\n   ', texto); return true; }
  const r = await fetch(`https://formsubmit.co/ajax/${FORM}`, {method: 'POST',
    headers: {'Content-Type': 'application/json', Accept: 'application/json', Origin: SITIO.replace(/\/$/, ''), Referer: SITIO},
    body: JSON.stringify({_subject: asunto, _template: 'table', _captcha: 'false', Aviso: texto, Hora: hhmm(AHORA) + ' (Bolivia)'})});
  const j = await r.json().catch(() => ({}));
  if(!r.ok || String(j.success) !== 'true'){ console.error('No se pudo enviar el correo:', r.status, JSON.stringify(j)); return false; }
  return true;
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

async function revisarEdificio(ed, m, enviados, conRondas){
  const desde = new Date(AHORA - 3 * 864e5).toISOString();
  const ev = await api(`eventos?select=created_at,tipo,guardia,detalle&edificio=eq.${enc(ed)}&created_at=gte.${enc(desde)}`
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
async function revisarSolicitudes(enviados){
  const desde = new Date(AHORA - 2 * 864e5).toISOString();
  const ev = await api(`eventos?select=created_at,edificio,guardia,detalle&tipo=eq.Solicitud&created_at=gte.${enc(desde)}&order=created_at.asc&limit=500`);
  const pedidos = new Map();
  const todos = await api(`eventos?select=edificio,guardia,detalle&tipo=eq.Solicitud&created_at=gte.${enc(new Date(AHORA - 120 * 864e5).toISOString())}&limit=3000`);
  for(const e of todos){ const d = det(e); if(d.sid && (d.clase === 'adelanto' || d.clase === 'libre')) pedidos.set(String(d.sid), e); }
  const fechaTxt = ymd => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : (ymd || ''); };
  const out = [];
  for(const e of ev){
    const d = det(e), sid = String(d.sid || ''); if(!sid) continue;
    const quien = e.guardia || 'Un guardia', ed = e.edificio + (d.bloque ? ' · ' + d.bloque : '');
    const motivo = d.motivo ? ` Motivo: ${d.motivo}.` : '';
    if(d.clase === 'adelanto'){
      const clave = 'sol|' + sid; if(enviados.has(clave)) continue;
      out.push({clave, asunto: `Osiris · ${quien} pide un adelanto`, texto: `${quien} (${ed}) pidió un adelanto a las ${hhmm(hora(e))}.${motivo} Apruébalo o recházalo en el monitor (Guardias).`});
    } else if(d.clase === 'libre'){
      const clave = 'sol|' + sid; if(enviados.has(clave)) continue;
      out.push({clave, asunto: `Osiris · ${quien} pide día libre`, texto: `${quien} (${ed}) pidió día libre para el ${fechaTxt(d.fecha)}.${motivo} Apruébalo o recházalo en el monitor (Guardias).`});
    } else if(d.clase === 'monto'){
      const clave = 'monto|' + sid + '|' + d.monto; if(enviados.has(clave)) continue;
      const p = pedidos.get(sid); const q = p ? (p.guardia || quien) : quien;
      out.push({clave, asunto: `Osiris · ${q} recibió Bs ${d.monto} de adelanto`, texto: `${q} (${ed}) escribió que recibió Bs ${d.monto} de adelanto. Confírmalo en el monitor (Guardias) si es lo que le diste.`});
    }
  }
  return out;
}

(async () => {
  const cfg = await api(`eventos?select=edificio,detalle,created_at&tipo=eq.Config&edificio=neq.__monitor__&order=created_at.desc&limit=2000`);
  const ultima = new Map();
  for(const e of cfg){ if(!ultima.has(e.edificio)) ultima.set(e.edificio, e); }
  const enviados = await avisosEnviados();
  let total = 0;
  for(const [ed, e] of ultima){
    let m = det(e).modulos; if(typeof m === 'string'){ try{ m = JSON.parse(m); }catch(_){ m = {}; } }
    if(!m || ed === '*' || ed.startsWith('__')) continue;
    if(m.alertas === false && m.alertas_ronda !== true) continue;
    try{
      for(const a of await revisarEdificio(ed, m, enviados, m.alertas_ronda === true)){
        if(m.alertas === false && a.clave.startsWith('ing|')) continue;
        if(await correo(a.asunto, a.texto)){ await anotar(a.clave, a.texto); enviados.add(a.clave); total++; }
      }
    }catch(x){ console.error(ed, x.message); }
  }
  try{
    for(const a of await revisarSolicitudes(enviados)){
      if(await correo(a.asunto, a.texto)){ await anotar(a.clave, a.texto); enviados.add(a.clave); total++; }
    }
  }catch(x){ console.error('solicitudes', x.message); }
  console.log(`Listo · ${total} aviso(s) · ${AHORA.toISOString()}`);
})().catch(e => { console.error(e); process.exit(1); });
