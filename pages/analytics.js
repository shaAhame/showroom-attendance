import { useState, useEffect, useRef } from 'react'
import Head from 'next/head'
import { db } from '../lib/firebase'
import { collection, getDocs, query, where } from 'firebase/firestore'

const SHOWROOMS = [
  { key: 'Idealz Marino',       icon: '🏛️' },
  { key: 'Idealz Liberty Plaza', icon: '🏬' },
  { key: 'Idealz Prime',        icon: '🏪' },
]

// Shift schedules per location + staff type
const SHIFTS = {
  'Idealz Marino':       { showroom:   { start:'10:00', end:'20:00' } },
  'Idealz Liberty Plaza': { showroom:   { start:'10:00', end:'19:00' } },
  'Idealz Prime':        { showroom:   { start:'09:45', end:'19:30' },
                           backoffice: { start:'09:30', end:'18:30' } },
}
function getShift(showroom, staffType='showroom') {
  const sh = SHIFTS[showroom]
  if (!sh) return { start:'09:00', end:'18:00' }
  return sh[staffType] || sh.showroom
}

function toMin(t) { if (!t) return null; const [h, m] = t.split(':').map(Number); return h * 60 + m }
function toStr(m) { if (m == null) return '—'; return `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}` }
function fmtHrs(m) { if (!m || m <= 0) return '0h 0m'; return `${Math.floor(m/60)}h ${m%60}m` }
function today() { return new Date().toISOString().split('T')[0] }

function getWeekRange(d) {
  const dd = new Date(d)
  const day = dd.getDay()
  const diff = day === 0 ? -6 : 1 - day
  const start = new Date(dd); start.setDate(dd.getDate() + diff)
  const end = new Date(start); end.setDate(start.getDate() + 6)
  return { start, end }
}

function dateStr(d) { return d.toISOString().split('T')[0] }

// ── fetch records from Firebase ──────────────────────────────────────────────
async function fetchRecords(filters = {}) {
  const col = collection(db, 'records')
  let constraints = []
  if (filters.date)     constraints.push(where('date',     '==', filters.date))
  if (filters.showroom) constraints.push(where('showroom', '==', filters.showroom))
  if (filters.dateGte)  constraints.push(where('date',     '>=', filters.dateGte))
  if (filters.dateLte)  constraints.push(where('date',     '<=', filters.dateLte))
  try {
    const snap = await getDocs(constraints.length ? query(col, ...constraints) : col)
    return snap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch {
    const snap = await getDocs(col)
    let data = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    if (filters.date)     data = data.filter(r => r.date     === filters.date)
    if (filters.showroom) data = data.filter(r => r.showroom === filters.showroom)
    if (filters.dateGte)  data = data.filter(r => r.date     >= filters.dateGte)
    if (filters.dateLte)  data = data.filter(r => r.date     <= filters.dateLte)
    return data
  }
}

async function fetchEmployees() {
  const snap = await getDocs(collection(db, 'employees'))
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
}

// ── derive per-employee day stats ─────────────────────────────────────────────
function deriveStats(empId, dateRecords, showroom, staffType='showroom') {
  const shift = getShift(showroom, staffType)
  const sMin = toMin(shift.start), eMin = toMin(shift.end)
  const recs = dateRecords.filter(r => r.empId === empId)
  if (!recs.length) return null

  const arrRec  = recs.find(r => r.type === 'arrive')
  const depRec  = recs.find(r => r.type === 'depart')
  const leaveRecs = recs.filter(r => r.type === 'leave')

  const arrive  = arrRec  ? toMin(arrRec.time)  : null
  const depart  = depRec  ? toMin(depRec.time)  : null
  const leaveDur = leaveRecs.reduce((a, r) => a + (r.duration || 0), 0)
  const leaveReasons = leaveRecs.map(r => r.reason).filter(Boolean).join(', ')

  const lateBy    = arrive != null && arrive > sMin ? arrive - sMin : 0
  const earlyExit = depart != null && depart < eMin ? eMin - depart : 0
  const workMin   = arrive != null && depart != null ? Math.max(0, depart - arrive - leaveDur) : null
  const shiftMin  = eMin - sMin
  const halfDay   = workMin != null && workMin > 0 && workMin < shiftMin / 2

  return { arrive, depart, lateBy, earlyExit, leaveDur, leaveReasons, workMin, halfDay, sMin, eMin }
}

// ─────────────────────────────────────────────────────────────────────────────
export default function Analytics() {
  const [view,    setView]    = useState('day')
  const [curDate, setCurDate] = useState(new Date())
  const [room,    setRoom]    = useState('all')
  const [emps,    setEmps]    = useState([])
  const [records, setRecords] = useState([])
  const [loading, setLoading] = useState(true)
  const chartRef = useRef(null)
  const chartInst = useRef(null)

  useEffect(() => { fetchEmployees().then(setEmps) }, [])

  useEffect(() => {
    setLoading(true)
    let filters = {}
    if (view === 'day') {
      filters.date = dateStr(curDate)
    } else if (view === 'week') {
      const { start, end } = getWeekRange(curDate)
      filters.dateGte = dateStr(start); filters.dateLte = dateStr(end)
    } else {
      const y = curDate.getFullYear(), m = curDate.getMonth()
      filters.dateGte = `${y}-${String(m+1).padStart(2,'0')}-01`
      filters.dateLte = `${y}-${String(m+1).padStart(2,'0')}-${String(new Date(y,m+1,0).getDate()).padStart(2,'0')}`
    }
    if (room !== 'all') filters.showroom = room
    fetchRecords(filters).then(r => { setRecords(r); setLoading(false) })
  }, [view, curDate, room])

  // ── helpers ────────────────────────────────────────────────────────────────
  const filteredEmps = room === 'all' ? emps : emps.filter(e => e.showroom === room)

  function navDate(dir) {
    const d = new Date(curDate)
    if (view === 'day')   d.setDate(d.getDate() + dir)
    if (view === 'week')  d.setDate(d.getDate() + dir * 7)
    if (view === 'month') d.setMonth(d.getMonth() + dir)
    setCurDate(d)
  }

  function dateLbl() {
    if (view === 'day')   return curDate.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short', year:'numeric' })
    if (view === 'week') {
      const { start, end } = getWeekRange(curDate)
      return start.toLocaleDateString('en-GB',{day:'numeric',month:'short'}) + ' – ' + end.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})
    }
    return curDate.toLocaleDateString('en-GB', { month:'long', year:'numeric' })
  }

  // ── KPI compute ────────────────────────────────────────────────────────────
  function computeKPIs() {
    const dates = view === 'day'
      ? [dateStr(curDate)]
      : view === 'week'
        ? (() => { const { start } = getWeekRange(curDate); return Array.from({length:7},(_,i)=>{ const d=new Date(start); d.setDate(d.getDate()+i); return dateStr(d) }) })()
        : (() => { const y=curDate.getFullYear(),m=curDate.getMonth(),days=new Date(y,m+1,0).getDate(); return Array.from({length:days},(_,i)=>`${y}-${String(m+1).padStart(2,'0')}-${String(i+1).padStart(2,'0')}`) })()

    let present=0, absent=0, late=0, earlyEx=0, leaves=0, halfDays=0, totalMin=0, count=0
    dates.forEach(d => {
      const dayRecs = records.filter(r => r.date === d)
      filteredEmps.forEach(emp => {
        const s = deriveStats(emp.empId, dayRecs, emp.showroom, emp.staffType||'showroom')
        if (!s) return
        if (s.arrive != null) { present++; if (s.workMin) { totalMin += s.workMin; count++ } }
        if (s.lateBy > 0) late++
        if (s.earlyExit > 0) earlyEx++
        if (s.leaveDur > 0) leaves++
        if (s.halfDay) halfDays++
      })
    })
    const avgHrs = count ? Math.round(totalMin / count) : 0
    return { present, late, earlyEx, leaves, halfDays, avgHrs }
  }

  const kpis = emps.length ? computeKPIs() : {}

  // ── render helpers ─────────────────────────────────────────────────────────
  function badge(txt, type) {
    const map = { ok:'#E1F5EE:#0F6E56', warn:'#FAEEDA:#854F0B', danger:'#FAECE7:#993C1D', info:'#E6F1FB:#185FA5', gray:'#F1EFE8:#5F5E5A' }
    const [bg,col] = (map[type]||map.gray).split(':')
    return <span style={{ background:bg, color:col, padding:'2px 8px', borderRadius:4, fontSize:11, fontWeight:500 }}>{txt}</span>
  }

  function statusBadge(s) {
    if (!s || s.arrive == null) return badge('Absent','danger')
    if (s.halfDay)  return badge('Half day','warn')
    if (s.lateBy > 15) return badge('Late','warn')
    return badge('Present','ok')
  }

  // ── Day view ───────────────────────────────────────────────────────────────
  function DayView() {
    const dayRecs = records.filter(r => r.date === dateStr(curDate))
    return (
      <div style={S.section}>
        <div style={S.secHead}><span style={S.secTitle}>Employee detail</span><span style={S.secSub}>{dateStr(curDate)}</span></div>
        <div style={{ overflowX:'auto' }}>
          <table style={S.table}>
            <thead><tr>
              {['Employee','Showroom','Status','Arrived','Departed','Late by','Early exit','Leave','Hours worked'].map(h =>
                <th key={h} style={S.th}>{h}</th>
              )}
            </tr></thead>
            <tbody>
              {filteredEmps.map(emp => {
                const s = deriveStats(emp.empId, dayRecs, emp.showroom, emp.staffType||'showroom')
                return (
                  <tr key={emp.id} style={S.tr}>
                    <td style={S.td}>{emp.name}</td>
                    <td style={S.td}>{badge(emp.showroom.replace('Idealz ',''),'info')} {emp.staffType==='backoffice'&&<span style={{marginLeft:4,fontSize:10,background:'#FAEEDA',color:'#854F0B',padding:'1px 6px',borderRadius:3}}>Back Office</span>}</td>
                    <td style={S.td}>{statusBadge(s)}</td>
                    <td style={{ ...S.td, color: s?.lateBy > 0 ? '#BA7517' : 'var(--color-text-primary)' }}>{s ? toStr(s.arrive) : '—'}</td>
                    <td style={{ ...S.td, color: s?.earlyExit > 0 ? '#D85A30' : 'var(--color-text-primary)' }}>{s ? toStr(s.depart) : '—'}</td>
                    <td style={S.td}>{s?.lateBy > 0 ? badge(`+${s.lateBy}m`,'warn') : s ? badge('On time','ok') : '—'}</td>
                    <td style={S.td}>{s?.earlyExit > 0 ? badge(`-${s.earlyExit}m`,'danger') : '—'}</td>
                    <td style={S.td}>{s?.leaveDur > 0 ? badge(`${s.leaveDur}m`,'info') : '—'}</td>
                    <td style={S.td}>
                      {s?.workMin != null ? (
                        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                          <div style={{ flex:1, height:6, background:'var(--color-background-secondary)', borderRadius:3, overflow:'hidden' }}>
                            <div style={{ height:'100%', borderRadius:3, width:`${Math.min(100,Math.round(s.workMin/(s.eMin-s.sMin)*100))}%`, background: s.halfDay ? '#BA7517' : '#1D9E75' }}/>
                          </div>
                          <span style={{ fontSize:11, color:'var(--color-text-secondary)', minWidth:48 }}>{fmtHrs(s.workMin)}</span>
                        </div>
                      ) : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  // ── Week view ──────────────────────────────────────────────────────────────
  function WeekView() {
    const { start } = getWeekRange(curDate)
    const days = Array.from({length:7}, (_,i) => { const d=new Date(start); d.setDate(d.getDate()+i); return d })
    return (
      <div style={S.section}>
        <div style={S.secHead}><span style={S.secTitle}>Weekly summary</span></div>
        <div style={{ overflowX:'auto' }}>
          <table style={S.table}>
            <thead><tr>
              <th style={S.th}>Employee</th>
              {days.map(d => <th key={d} style={S.th}>{d.toLocaleDateString('en-GB',{weekday:'short',day:'numeric'})}</th>)}
              <th style={S.th}>Total hrs</th>
              <th style={S.th}>Late</th>
              <th style={S.th}>Early exits</th>
              <th style={S.th}>Leaves</th>
              <th style={S.th}>Half days</th>
            </tr></thead>
            <tbody>
              {filteredEmps.map(emp => {
                const stats = days.map(d => deriveStats(emp.empId, records.filter(r=>r.date===dateStr(d)), emp.showroom, emp.staffType||'showroom'))
                const totalMin = stats.reduce((a,s) => a + (s?.workMin||0), 0)
                const lates    = stats.filter(s=>s?.lateBy>0).length
                const earlyEx  = stats.filter(s=>s?.earlyExit>0).length
                const leaves   = stats.filter(s=>s?.leaveDur>0).length
                const halfDays = stats.filter(s=>s?.halfDay).length
                return (
                  <tr key={emp.id} style={S.tr}>
                    <td style={S.td}><span style={{fontWeight:500}}>{emp.name.split(' ')[0]}</span> <span style={{color:'var(--color-text-secondary)',fontSize:12}}>{emp.name.split(' ').slice(1).join(' ')}</span></td>
                    {stats.map((s,i) => (
                      <td key={i} style={S.td}>
                        {!s ? <span style={{color:'var(--color-text-secondary)'}}>—</span>
                          : s.arrive == null ? badge('Abs','danger')
                          : s.halfDay ? badge('½','warn')
                          : s.lateBy > 0 ? <span style={{color:'#BA7517',fontSize:12}}>{toStr(s.arrive)}</span>
                          : <span style={{color:'#1D9E75',fontSize:12}}>{toStr(s.arrive)}</span>}
                      </td>
                    ))}
                    <td style={S.td}><strong>{fmtHrs(totalMin)}</strong></td>
                    <td style={S.td}>{lates > 0   ? badge(lates,'warn')   : <span style={{color:'var(--color-text-secondary)'}}>0</span>}</td>
                    <td style={S.td}>{earlyEx > 0 ? badge(earlyEx,'danger') : <span style={{color:'var(--color-text-secondary)'}}>0</span>}</td>
                    <td style={S.td}>{leaves > 0  ? badge(leaves,'info')  : <span style={{color:'var(--color-text-secondary)'}}>0</span>}</td>
                    <td style={S.td}>{halfDays > 0 ? badge(halfDays,'warn') : <span style={{color:'var(--color-text-secondary)'}}>0</span>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  // ── Month view ─────────────────────────────────────────────────────────────
  function MonthView() {
    const y = curDate.getFullYear(), m = curDate.getMonth()
    const daysInMonth = new Date(y, m+1, 0).getDate()
    return (
      <>
        <div style={S.section}>
          <div style={S.secHead}><span style={S.secTitle}>Monthly employee summary</span></div>
          <div style={{ overflowX:'auto' }}>
            <table style={S.table}>
              <thead><tr>
                {['Employee','Showroom','Days in','Absent','Late','Early exits','Half days','Short leaves','Total hrs'].map(h =>
                  <th key={h} style={S.th}>{h}</th>
                )}
              </tr></thead>
              <tbody>
                {filteredEmps.map(emp => {
                  let daysIn=0, absent=0, late=0, earlyEx=0, halfDs=0, leaves=0, totalMin=0
                  for (let d=1; d<=daysInMonth; d++) {
                    const ds = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`
                    const dow = new Date(ds).getDay()
                    if (dow===0||dow===6) continue
                    const dayRecs = records.filter(r => r.date === ds)
                    const hasAny  = dayRecs.some(r => r.empId === emp.empId)
                    if (!hasAny) { absent++; continue }
                    const s = deriveStats(emp.empId, dayRecs, emp.showroom, emp.staffType||'showroom')
                    if (!s) continue
                    daysIn++
                    if (s.lateBy > 0)   late++
                    if (s.earlyExit > 0) earlyEx++
                    if (s.halfDay)       halfDs++
                    if (s.leaveDur > 0)  leaves++
                    if (s.workMin)       totalMin += s.workMin
                  }
                  return (
                    <tr key={emp.id} style={S.tr}>
                      <td style={S.td}>{emp.name}</td>
                      <td style={S.td}>{badge(emp.showroom.replace('Idealz ',''),'info')} {emp.staffType==='backoffice'&&<span style={{marginLeft:4,fontSize:10,background:'#FAEEDA',color:'#854F0B',padding:'1px 6px',borderRadius:3}}>Back Office</span>}</td>
                      <td style={S.td}>{daysIn}</td>
                      <td style={S.td}>{absent > 0   ? badge(absent,'danger')  : '0'}</td>
                      <td style={S.td}>{late > 0     ? badge(late,'warn')      : '0'}</td>
                      <td style={S.td}>{earlyEx > 0  ? badge(earlyEx,'warn')   : '0'}</td>
                      <td style={S.td}>{halfDs > 0   ? badge(halfDs,'warn')    : '0'}</td>
                      <td style={S.td}>{leaves > 0   ? badge(leaves,'info')    : '0'}</td>
                      <td style={S.td}><strong>{fmtHrs(totalMin)}</strong></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Per-showroom breakdown */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(200px,1fr))', gap:12, marginTop:12 }}>
          {SHOWROOMS.map(sh => {
            const shEmps = emps.filter(e => e.showroom === sh.key)
            let totalMin=0, lates=0, leaves=0
            for (let d=1; d<=daysInMonth; d++) {
              const ds = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`
              const dayRecs = records.filter(r => r.date === ds)
              shEmps.forEach(emp => {
                const s = deriveStats(emp.empId, dayRecs, emp.showroom, emp.staffType||'showroom')
                if (!s) return
                if (s.workMin) totalMin += s.workMin
                if (s.lateBy > 0) lates++
                if (s.leaveDur > 0) leaves++
              })
            }
            return (
              <div key={sh.key} style={{ ...S.section, padding:16 }}>
                <div style={{ fontSize:13, fontWeight:500, marginBottom:10 }}>{sh.icon} {sh.key}</div>
                <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                  <div style={S.statRow}><span style={{color:'var(--color-text-secondary)',fontSize:12}}>Staff</span><span style={{fontWeight:500}}>{shEmps.length}</span></div>
                  <div style={S.statRow}><span style={{color:'var(--color-text-secondary)',fontSize:12}}>Total hrs</span><span style={{fontWeight:500}}>{fmtHrs(totalMin)}</span></div>
                  <div style={S.statRow}><span style={{color:'var(--color-text-secondary)',fontSize:12}}>Late incidents</span><span style={{fontWeight:500,color:'#BA7517'}}>{lates}</span></div>
                  <div style={S.statRow}><span style={{color:'var(--color-text-secondary)',fontSize:12}}>Short leaves</span><span style={{fontWeight:500,color:'#185FA5'}}>{leaves}</span></div>
                </div>
              </div>
            )
          })}
        </div>
      </>
    )
  }

  // ── Styles ─────────────────────────────────────────────────────────────────
  const S = {
    section:  { background:'var(--color-background-primary)', border:'0.5px solid var(--color-border-tertiary)', borderRadius:'var(--border-radius-lg)', overflow:'hidden', marginBottom:12 },
    secHead:  { padding:'12px 16px', borderBottom:'0.5px solid var(--color-border-tertiary)', display:'flex', alignItems:'center', justifyContent:'space-between' },
    secTitle: { fontSize:13, fontWeight:500, color:'var(--color-text-primary)' },
    secSub:   { fontSize:12, color:'var(--color-text-secondary)' },
    table:    { width:'100%', borderCollapse:'collapse', fontSize:12 },
    th:       { padding:'8px 12px', textAlign:'left', color:'var(--color-text-secondary)', fontWeight:400, borderBottom:'0.5px solid var(--color-border-tertiary)', fontSize:11, textTransform:'uppercase', letterSpacing:'.04em', whiteSpace:'nowrap' },
    td:       { padding:'9px 12px', borderBottom:'0.5px solid var(--color-border-tertiary)', color:'var(--color-text-primary)', verticalAlign:'middle', whiteSpace:'nowrap' },
    tr:       {},
    statRow:  { display:'flex', justifyContent:'space-between', fontSize:12 },
  }

  return (
    <>
      <Head><title>Idealz Analytics</title><meta name="viewport" content="width=device-width,initial-scale=1"/></Head>

      <div style={{ position:'relative', zIndex:1 }}>
        {/* NAV */}
        <nav style={navStyle}>
          <a href="/" style={{ fontFamily:'var(--font-head)', fontSize:'1.1rem', fontWeight:800, letterSpacing:'-0.02em', display:'flex', alignItems:'center', gap:10, color:'var(--text)' }}>
            <div style={{ width:8, height:8, borderRadius:'50%', background:'var(--accent)', boxShadow:'0 0 12px var(--accent)' }}/>
            IDEALZ · ATTEND
          </a>
          <span style={{ fontSize:14, fontWeight:500, color:'var(--color-text-secondary)' }}>Analytics</span>
        </nav>

        <div style={{ padding:24, maxWidth:1200, margin:'0 auto' }}>
          {/* Controls */}
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:16, flexWrap:'wrap' }}>
            {/* View tabs */}
            <div style={{ display:'flex', gap:4, background:'var(--color-background-secondary)', padding:3, borderRadius:8, border:'0.5px solid var(--color-border-tertiary)' }}>
              {['day','week','month'].map(v => (
                <button key={v} onClick={() => setView(v)} style={{ padding:'5px 14px', border:'none', background: view===v ? 'var(--color-background-primary)' : 'transparent', borderRadius:6, fontSize:13, cursor:'pointer', color: view===v ? 'var(--color-text-primary)' : 'var(--color-text-secondary)', fontWeight: view===v ? 500 : 400, ...(view===v ? { border:'0.5px solid var(--color-border-tertiary)' } : {}) }}>
                  {v.charAt(0).toUpperCase()+v.slice(1)}
                </button>
              ))}
            </div>

            {/* Showroom filter */}
            <div style={{ display:'flex', gap:4 }}>
              {[{k:'all',l:'All'},...SHOWROOMS.map(s=>({k:s.key,l:s.key.replace('Idealz ','')}))].map(({k,l}) => (
                <button key={k} onClick={() => setRoom(k)} style={{ padding:'5px 12px', border:'0.5px solid var(--color-border-tertiary)', background: room===k ? 'var(--color-background-info)' : 'var(--color-background-primary)', borderRadius:8, fontSize:12, cursor:'pointer', color: room===k ? 'var(--color-text-info)' : 'var(--color-text-secondary)', fontWeight: room===k ? 500 : 400 }}>{l}</button>
              ))}
            </div>

            {/* Date nav */}
            <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:6 }}>
              <button onClick={() => navDate(-1)} style={navBtn}>←</button>
              <span style={{ fontSize:13, fontWeight:500, minWidth:200, textAlign:'center', color:'var(--color-text-primary)' }}>{dateLbl()}</span>
              <button onClick={() => navDate(1)} style={navBtn}>→</button>
            </div>
          </div>

          {/* KPIs */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(110px,1fr))', gap:10, marginBottom:16 }}>
            {[
              { l:'Present',     v: kpis.present  ?? '—', c:'#1D9E75' },
              { l:'Late arrivals',v: kpis.late     ?? '—', c: kpis.late > 0 ? '#BA7517' : '#1D9E75' },
              { l:'Early exits', v: kpis.earlyEx  ?? '—', c: kpis.earlyEx > 0 ? '#D85A30' : '#1D9E75' },
              { l:'Short leaves',v: kpis.leaves   ?? '—', c:'#185FA5' },
              { l:'Half days',   v: kpis.halfDays ?? '—', c: kpis.halfDays > 0 ? '#BA7517' : '#1D9E75' },
              { l:'Avg hrs/day', v: fmtHrs(kpis.avgHrs), c:'var(--color-text-primary)' },
            ].map(k => (
              <div key={k.l} style={{ background:'var(--color-background-secondary)', borderRadius:8, padding:'12px 14px' }}>
                <div style={{ fontSize:11, color:'var(--color-text-secondary)', marginBottom:4, textTransform:'uppercase', letterSpacing:'.04em' }}>{k.l}</div>
                <div style={{ fontSize:22, fontWeight:500, color:k.c }}>{loading ? '…' : k.v}</div>
              </div>
            ))}
          </div>

          {/* Main content */}
          {loading
            ? <div style={{ textAlign:'center', padding:48, color:'var(--color-text-secondary)', fontSize:14 }}>Loading…</div>
            : view === 'day'   ? <DayView/>
            : view === 'week'  ? <WeekView/>
            : <MonthView/>
          }
        </div>
      </div>
    </>
  )
}

const navStyle = { display:'flex', alignItems:'center', justifyContent:'space-between', padding:'18px 32px', borderBottom:'1px solid var(--border)', background:'rgba(10,10,15,0.9)', backdropFilter:'blur(12px)', position:'sticky', top:0, zIndex:100 }
const navBtn = { padding:'5px 10px', border:'0.5px solid var(--color-border-tertiary)', background:'var(--color-background-primary)', borderRadius:8, cursor:'pointer', fontSize:13, color:'var(--color-text-primary)' }
