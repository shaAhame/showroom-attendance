import { useState, useEffect } from 'react'
import Head from 'next/head'
import { db } from '../lib/firebase'
import { collection, getDocs, addDoc, deleteDoc, doc, query, orderBy, where } from 'firebase/firestore'

const SHOWROOMS = ['Idealz Marino', 'Idealz Libert Plaza', 'Idealz Prime']
const ICONS = ['🏛️', '🏬', '🏪']
const COLORS = ['#6c63ff','#ff6584','#43e97b','#f7c948','#38b6ff','#ff9a4a','#a78bfa','#34d399']
const SHIFTS = {
  'Idealz Marino':       { showroom:   { start:'10:00', end:'20:00' } },
  'Idealz Libert Plaza': { showroom:   { start:'10:00', end:'19:00' } },
  'Idealz Prime':        { showroom:   { start:'09:45', end:'19:30' },
                           backoffice: { start:'09:30', end:'18:30' } },
}
function getShift(showroom, staffType='showroom') {
  const sh = SHIFTS[showroom]; if (!sh) return { start:'09:00', end:'18:00' }
  return sh[staffType] || sh.showroom
}
function today() { return new Date().toISOString().split('T')[0] }
function nowTime() { return new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'}) }
function initials(name='') { return name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase() }

async function fingerprintAuth() {
  if (!window.PublicKeyCredential) return simulateScan()
  const challenge = new Uint8Array(32); crypto.getRandomValues(challenge)
  try {
    const cred = await navigator.credentials.get({
      publicKey:{ challenge, timeout:30000, userVerification:'preferred', rpId:location.hostname }
    }).catch(async()=>navigator.credentials.create({
      publicKey:{
        challenge, rp:{name:'Idealz Attend',id:location.hostname},
        user:{id:new Uint8Array(16),name:'employee',displayName:'Employee'},
        pubKeyCredParams:[{type:'public-key',alg:-7},{type:'public-key',alg:-257}],
        timeout:30000, authenticatorSelection:{userVerification:'preferred',authenticatorAttachment:'platform'}
      }
    }))
    return !!cred
  } catch(e) { if(e.name==='NotAllowedError') return false; return simulateScan() }
}
function simulateScan() { return new Promise(r=>setTimeout(()=>r(true),1800)) }

async function fbGetEmployees() {
  try { const s=await getDocs(query(collection(db,'employees'),orderBy('name'))); return s.docs.map(d=>({id:d.id,...d.data()})) }
  catch { const s=await getDocs(collection(db,'employees')); return s.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>a.name.localeCompare(b.name)) }
}
async function fbGetTodayRecords() {
  try { const s=await getDocs(query(collection(db,'records'),where('date','==',today()))); return s.docs.map(d=>({id:d.id,...d.data()})) }
  catch { const s=await getDocs(collection(db,'records')); return s.docs.map(d=>({id:d.id,...d.data()})).filter(r=>r.date===today()) }
}
async function fbSeedIfEmpty() {
  const s=await getDocs(collection(db,'employees')); if(!s.empty) return
  const seeds=[
    {empId:'EMP-001',name:'Ahmed Al-Rashid',  showroom:'Idealz Marino',       staffType:'showroom',   color:'#6c63ff'},
    {empId:'EMP-002',name:'Sara Mohammed',    showroom:'Idealz Marino',       staffType:'showroom',   color:'#ff6584'},
    {empId:'EMP-003',name:'Khalid Hassan',    showroom:'Idealz Libert Plaza', staffType:'showroom',   color:'#43e97b'},
    {empId:'EMP-004',name:'Fatima Abdullah',  showroom:'Idealz Libert Plaza', staffType:'showroom',   color:'#f7c948'},
    {empId:'EMP-005',name:'Omar Al-Farsi',    showroom:'Idealz Prime',        staffType:'showroom',   color:'#38b6ff'},
    {empId:'EMP-006',name:'Layla Nasser',     showroom:'Idealz Prime',        staffType:'backoffice', color:'#ff9a4a'},
    {empId:'EMP-007',name:'Hassan Al-Mutairi',showroom:'Idealz Prime',        staffType:'backoffice', color:'#a78bfa'},
  ]
  for(const e of seeds) await addDoc(collection(db,'employees'),{...e,createdAt:Date.now()})
}

export default function Home() {
  const [tab,setTab]           = useState('checkin')
  const [employees,setEmps]    = useState([])
  const [todayRecs,setTodayRecs] = useState([])
  const [stats,setStats]       = useState({})
  const [selRoom,setSelRoom]   = useState('')
  const [selEmp,setSelEmp]     = useState('')
  const [log,setLog]           = useState([])
  const [fpOverlay,setFpOv]    = useState(false)
  const [fpLabel,setFpLabel]   = useState('')
  const [leaveModal,setLeaveM] = useState(false)
  const [leaveEmp,setLeaveEmp] = useState('')
  const [leaveDur,setLeaveDur] = useState('30')
  const [leaveReason,setLeaveR]= useState('')
  const [toast,setToast]       = useState(null)
  const [clock,setClock]       = useState('')
  const [clockDate,setClockDate]= useState('')
  const [newName,setNewName]   = useState('')
  const [newId,setNewId]       = useState('')
  const [newRoom,setNewRoom]   = useState('Idealz Marino')
  const [newST,setNewST]       = useState('showroom')
  const [allRecs,setAllRecs]   = useState([])
  const [loading,setLoading]   = useState(false)
  const [fRoom,setFRoom]       = useState('')
  const [fEmp,setFEmp]         = useState('')
  const [fDate,setFDate]       = useState('')
  const [fType,setFType]       = useState('')

  useEffect(()=>{
    const t=setInterval(()=>{
      const n=new Date()
      setClock(n.toLocaleTimeString('en-GB'))
      setClockDate(n.toLocaleDateString('en-GB',{weekday:'short',day:'2-digit',month:'short',year:'numeric'}))
    },1000); return()=>clearInterval(t)
  },[])

  useEffect(()=>{ fbSeedIfEmpty().then(loadAll) },[])
  useEffect(()=>{ if(tab==='report') loadReports() },[tab,fRoom,fEmp,fDate,fType])

  async function loadAll() {
    const [emps,recs]=await Promise.all([fbGetEmployees(),fbGetTodayRecords()])
    setEmps(emps); setTodayRecs(recs); computeStats(emps,recs)
  }
  function computeStats(emps,recs) {
    const arrived=new Set(recs.filter(r=>r.type==='arrive').map(r=>r.empId)).size
    const departed=new Set(recs.filter(r=>r.type==='depart').map(r=>r.empId)).size
    const onLeave=new Set(recs.filter(r=>r.type==='leave').map(r=>r.empId)).size
    const byShowroom={}
    SHOWROOMS.forEach(s=>{ byShowroom[s]=new Set(recs.filter(r=>r.showroom===s&&r.type==='arrive').map(r=>r.empId)).size })
    setStats({arrived,departed,onLeave,byShowroom})
  }
  function showToast(msg,type='success'){setToast({msg,type});setTimeout(()=>setToast(null),3200)}

  const empForRoom = selRoom ? employees.filter(e=>e.showroom===selRoom) : employees

  async function doAction(type) {
    if(!selEmp)   return showToast('Please select an employee.','error')
    if(!selRoom)  return showToast('Please select a showroom first.','error')
    const emp=employees.find(e=>e.id===selEmp); if(!emp) return
    setFpLabel(type==='arrive'?`Verifying arrival — ${emp.name}`:`Verifying departure — ${emp.name}`)
    setFpOv(true); const ok=await fingerprintAuth(); setFpOv(false)
    if(!ok) return showToast('Fingerprint cancelled.','error')
    const rec={empId:emp.empId,empName:emp.name,showroom:selRoom,type,date:today(),time:nowTime(),reason:'',duration:0}
    await addDoc(collection(db,'records'),{...rec,createdAt:Date.now()})
    setLog(p=>[{...rec,id:Date.now()},...p])
    setTodayRecs(p=>{const n=[...p,rec];computeStats(employees,n);return n})
    showToast(`${type==='arrive'?'✅ Arrived':'🔴 Departed'}: ${emp.name}`)
  }

  async function submitLeave() {
    if(!leaveEmp) return showToast('Select an employee.','error')
    if(!selRoom)  return showToast('Select a showroom first.','error')
    const emp=employees.find(e=>e.id===leaveEmp); if(!emp) return
    setFpLabel(`Short leave — ${emp.name}`); setFpOv(true)
    const ok=await fingerprintAuth(); setFpOv(false)
    if(!ok) return showToast('Fingerprint cancelled.','error')
    const rec={empId:emp.empId,empName:emp.name,showroom:selRoom,type:'leave',date:today(),time:nowTime(),reason:leaveReason||'Short leave',duration:parseInt(leaveDur)}
    await addDoc(collection(db,'records'),{...rec,createdAt:Date.now()})
    setLog(p=>[{...rec,id:Date.now()},...p])
    setTodayRecs(p=>{const n=[...p,rec];computeStats(employees,n);return n})
    setLeaveM(false); setLeaveR('')
    showToast(`🕐 Short leave: ${emp.name} (~${leaveDur} min)`)
  }

  async function addEmployee() {
    if(!newName||!newId) return showToast('Fill in name and Employee ID.','error')
    if(employees.find(e=>e.empId===newId)) return showToast('Employee ID already exists.','error')
    const color=COLORS[Math.floor(Math.random()*COLORS.length)]
    try {
      const ref=await addDoc(collection(db,'employees'),{empId:newId,name:newName,showroom:newRoom,staffType:newST,color,createdAt:Date.now()})
      setEmps(p=>[...p,{id:ref.id,empId:newId,name:newName,showroom:newRoom,staffType:newST,color}].sort((a,b)=>a.name.localeCompare(b.name)))
      setNewName(''); setNewId(''); showToast(`✅ ${newName} added!`)
    } catch { showToast('Error adding employee. Check Firebase.','error') }
  }

  async function removeEmployee(id,name) {
    try { await deleteDoc(doc(db,'employees',id)); setEmps(p=>p.filter(e=>e.id!==id)); showToast(`🗑️ ${name} removed.`) }
    catch { showToast('Error removing employee.','error') }
  }

  async function loadReports() {
    setLoading(true)
    try {
      const snap=await getDocs(collection(db,'records'))
      let data=snap.docs.map(d=>({id:d.id,...d.data()}))
      if(fRoom) data=data.filter(r=>r.showroom===fRoom)
      if(fEmp)  data=data.filter(r=>r.empId===fEmp)
      if(fDate) data=data.filter(r=>r.date===fDate)
      if(fType) data=data.filter(r=>r.type===fType)
      setAllRecs(data.sort((a,b)=>b.createdAt-a.createdAt))
    } catch { showToast('Error loading records.','error') }
    setLoading(false)
  }

  function exportCSV() {
    const rows=[['Employee','Showroom','Type','Time','Date','Reason','Duration(min)']]
    allRecs.forEach(r=>rows.push([r.empName,r.showroom,r.type,r.time,r.date,r.reason||'',r.duration||'']))
    const csv=rows.map(r=>r.map(c=>`"${c}"`).join(',')).join('\n')
    const a=document.createElement('a'); a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv)
    a.download=`idealz-${today()}.csv`; a.click()
  }

  const typeLabel={arrive:'Arrive',depart:'Depart',leave:'Short Leave',return:'Return'}
  const logColors={arrive:'#43e97b',depart:'#ff6584',leave:'#f7c948',return:'#6c63ff'}

  return (<>
    <Head>
      <title>Idealz Attendance</title>
      <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/>
      <meta name="mobile-web-app-capable" content="yes"/>
      <meta name="apple-mobile-web-app-capable" content="yes"/>
      <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"/>
      <meta name="theme-color" content="#0a0a0f"/>
    </Head>
    <div style={{position:'relative',zIndex:1}}>

      {/* ── TOP NAV ── */}
      <nav className="nav-bar" style={S.nav}>
        <div style={S.brand}><div style={S.dot}/>IDEALZ · ATTEND</div>
        {/* Desktop tabs */}
        <div className="desktop-tabs" style={S.tabs}>
          {['checkin','report','admin'].map((t,i)=>(
            <button key={t} style={{...S.tab,...(tab===t?S.tabOn:{})}} onClick={()=>setTab(t)}>
              {['Check In/Out','Reports','Admin'][i]}
            </button>
          ))}
          <a href="/analytics" style={{...S.tab,textDecoration:'none',display:'flex',alignItems:'center',color:'var(--muted)'}}>Analytics</a>
        </div>
        <div className="desktop-clock" style={{fontSize:'0.82rem',color:'var(--muted)'}}>
          <span style={{color:'var(--text)'}}>{clock}</span>&nbsp;<span>{clockDate}</span>
        </div>
        {/* Mobile: show current tab name */}
        <div style={{display:'none'}} className="mobile-tab-title" id="mobileTitle">
          {['Check In/Out','Reports','Admin'][['checkin','report','admin'].indexOf(tab)]||'Check In/Out'}
        </div>
      </nav>

      {/* ── CHECK IN/OUT ── */}
      {tab==='checkin' && <div className="page-content" style={S.page}>
        <div className="page-h1" style={S.h1}>Check In / Out</div>
        <div style={S.sub}>Select showroom → employee → fingerprint</div>

        <div className="room-grid" style={S.roomGrid}>
          {SHOWROOMS.map((s,i)=>(
            <div key={s} style={{...S.roomCard,...(selRoom===s?S.roomOn:{})}} onClick={()=>{setSelRoom(s);setSelEmp('')}}>
              <div className="room-card-inner" style={{flexDirection:'column',display:'flex',alignItems:'center',textAlign:'center'}}>
                <div className="room-card-icon" style={{fontSize:'2rem',marginBottom:8}}>{ICONS[i]}</div>
                <div style={{fontFamily:'var(--font-head)',fontWeight:700,fontSize:'0.95rem',marginBottom:2}}>{s}</div>
                <div style={{fontSize:'0.7rem',color:'var(--muted)'}}>{stats.byShowroom?.[s]??0} in today</div>
              </div>
            </div>
          ))}
        </div>

        <div className="action-grid" style={S.grid2}>
          <div className="card-pad" style={S.card}>
            <h3 style={S.cardH}>Arrival / Departure</h3>
            {!selRoom&&<div style={{fontSize:'0.78rem',color:'var(--gold)',marginBottom:12,padding:'8px 12px',background:'rgba(247,201,72,0.1)',borderRadius:8}}>👆 Select a showroom above first</div>}
            <select style={{...S.sel,fontSize:'16px'}} value={selEmp} onChange={e=>setSelEmp(e.target.value)} disabled={!selRoom}>
              <option value="">— Select Employee —</option>
              {empForRoom.map(e=><option key={e.id} value={e.id}>{e.name} {e.staffType==='backoffice'?'(BO)':''}</option>)}
            </select>
            <button className="fp-btn" style={{...S.btn,background:'linear-gradient(135deg,#43e97b,#38f9d7)',color:'#0a0a0f',marginBottom:10,opacity:selRoom?1:0.5}} onClick={()=>doAction('arrive')}>
              👆 Fingerprint — Arrive
            </button>
            <button className="fp-btn" style={{...S.btn,background:'linear-gradient(135deg,#ff6584,#ff9a4a)',color:'#0a0a0f',marginBottom:10,opacity:selRoom?1:0.5}} onClick={()=>doAction('depart')}>
              👆 Fingerprint — Depart
            </button>
            <button className="fp-btn" style={{...S.btn,background:'linear-gradient(135deg,#f7c948,#ff9a4a)',color:'#0a0a0f',opacity:selRoom?1:0.5}} onClick={()=>{if(!selRoom)return showToast('Select a showroom first.','error');setLeaveM(true)}}>
              🕐 Short Leave
            </button>
          </div>

          <div className="card-pad" style={S.card}>
            <h3 style={S.cardH}>Today's Log</h3>
            <div style={S.logBox}>
              {log.length===0
                ? <div style={{color:'var(--muted)',fontSize:'0.78rem',textAlign:'center',padding:'20px 0'}}>No activity yet</div>
                : log.map(r=>(
                  <div key={r.id} style={S.logRow}>
                    <div style={{width:6,height:6,borderRadius:'50%',background:logColors[r.type]||'#fff',flexShrink:0,marginTop:5}}/>
                    <span style={{color:'var(--muted)',fontSize:'0.72rem',whiteSpace:'nowrap'}}>{r.time}</span>
                    <span style={{fontSize:'0.76rem',overflow:'hidden',textOverflow:'ellipsis'}}>{r.empName} · {typeLabel[r.type]}{r.duration?` (${r.duration}m)`:''}</span>
                  </div>
                ))}
            </div>
          </div>
        </div>
      </div>}

      {/* ── REPORTS ── */}
      {tab==='report' && <div className="page-content" style={S.page}>
        <div className="page-h1" style={S.h1}>Reports</div>
        <div style={S.sub}>Filter and export attendance records</div>

        <div className="filters-row" style={S.filters}>
          <select style={{...S.sel,width:'auto',minWidth:130}} value={fRoom} onChange={e=>setFRoom(e.target.value)}>
            <option value="">All Showrooms</option>
            {SHOWROOMS.map(s=><option key={s} value={s}>{s.replace('Idealz ','')}</option>)}
          </select>
          <select style={{...S.sel,width:'auto',minWidth:130}} value={fEmp} onChange={e=>setFEmp(e.target.value)}>
            <option value="">All Employees</option>
            {employees.map(e=><option key={e.id} value={e.empId}>{e.name}</option>)}
          </select>
          <input type="date" style={{...S.sel,width:'auto',minWidth:140}} value={fDate} onChange={e=>setFDate(e.target.value)}/>
          <select style={{...S.sel,width:'auto',minWidth:120}} value={fType} onChange={e=>setFType(e.target.value)}>
            <option value="">All Types</option>
            <option value="arrive">Arrive</option>
            <option value="depart">Depart</option>
            <option value="leave">Leave</option>
          </select>
          <button style={S.exportBtn} onClick={exportCSV}>⬇ CSV</button>
        </div>

        <div className="stats-grid" style={S.statsGrid}>
          {[{l:'Total',v:allRecs.length,c:'var(--accent)'},{l:'Arrived',v:stats.arrived??0,c:'var(--accent3)'},{l:'Departed',v:stats.departed??0,c:'var(--accent2)'},{l:'Leaves',v:stats.onLeave??0,c:'var(--gold)'}].map(s=>(
            <div key={s.l} style={S.statCard}>
              <div style={{fontSize:'0.68rem',color:'var(--muted)',textTransform:'uppercase',letterSpacing:'.06em',marginBottom:4}}>{s.l}</div>
              <div style={{fontFamily:'var(--font-head)',fontSize:'1.8rem',fontWeight:800,color:s.c}}>{s.v}</div>
            </div>
          ))}
        </div>

        <div className="table-scroll">
          {loading
            ? <div style={{textAlign:'center',padding:32,color:'var(--muted)'}}>Loading…</div>
            : <table style={{width:'100%',borderCollapse:'collapse',fontSize:'0.78rem',minWidth:600}}>
              <thead><tr style={{borderBottom:'1px solid var(--border)'}}>
                {['Employee','Showroom','Type','Time','Date','Reason','Dur.'].map(h=>(
                  <th key={h} style={{textAlign:'left',padding:'8px 10px',color:'var(--muted)',fontWeight:400,fontSize:'0.68rem',textTransform:'uppercase',letterSpacing:'.06em',whiteSpace:'nowrap'}}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {allRecs.length===0
                  ? <tr><td colSpan={7} style={{textAlign:'center',color:'var(--muted)',padding:32}}>No records found</td></tr>
                  : allRecs.map(r=>(
                    <tr key={r.id} style={{borderBottom:'1px solid rgba(42,42,61,0.5)'}}>
                      <td style={{padding:'10px 10px',whiteSpace:'nowrap'}}>{r.empName?.split(' ')[0]}</td>
                      <td style={{padding:'10px 10px',whiteSpace:'nowrap',color:'var(--muted)',fontSize:'0.72rem'}}>{r.showroom?.replace('Idealz ','')}</td>
                      <td style={{padding:'10px 10px'}}><span style={badge(r.type)}>{typeLabel[r.type]||r.type}</span></td>
                      <td style={{padding:'10px 10px',whiteSpace:'nowrap'}}>{r.time}</td>
                      <td style={{padding:'10px 10px',whiteSpace:'nowrap',color:'var(--muted)'}}>{r.date}</td>
                      <td style={{padding:'10px 10px',color:'var(--muted)',maxWidth:120,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r.reason||'—'}</td>
                      <td style={{padding:'10px 10px',color:'var(--muted)',whiteSpace:'nowrap'}}>{r.duration?`${r.duration}m`:'—'}</td>
                    </tr>
                  ))}
              </tbody>
            </table>}
        </div>
      </div>}

      {/* ── ADMIN ── */}
      {tab==='admin' && <div className="page-content" style={S.page}>
        <div className="page-h1" style={S.h1}>Admin Panel</div>
        <div style={S.sub}>Manage employees</div>
        <div className="admin-grid" style={S.grid2}>
          <div className="card-pad" style={S.card}>
            <h3 style={S.cardH}>👥 Employees ({employees.length})</h3>
            <div style={{display:'flex',flexDirection:'column',gap:8,maxHeight:460,overflowY:'auto'}}>
              {employees.length===0
                ? <div style={{color:'var(--muted)',fontSize:'0.8rem',textAlign:'center',padding:20}}>No employees yet</div>
                : employees.map(e=>{
                  const recs=todayRecs.filter(r=>r.empId===e.empId)
                  const last=[...recs].sort((a,b)=>(b.createdAt||0)-(a.createdAt||0))[0]
                  const sm={arrive:['Present','#43e97b'],depart:['Departed','#ff6584'],leave:['On Leave','#f7c948'],return:['Returned','#6c63ff']}
                  const [lbl,clr]=(last&&sm[last.type])||['Not in','#6b6b8a']
                  const shift=getShift(e.showroom,e.staffType)
                  return(
                    <div key={e.id} style={{display:'flex',alignItems:'center',gap:10,padding:'10px 12px',background:'var(--surface)',borderRadius:10,border:'1px solid var(--border)'}}>
                      <div style={{width:38,height:38,borderRadius:'50%',background:e.color+'22',color:e.color,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:700,fontSize:'0.82rem',flexShrink:0}}>{initials(e.name)}</div>
                      <div style={{flex:1,minWidth:0}}>
                        <div className="emp-item-name" style={{fontSize:'0.83rem',fontWeight:500,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{e.name}</div>
                        <div className="emp-item-sub" style={{fontSize:'0.69rem',color:'var(--muted)'}}>{e.empId} · {e.showroom.replace('Idealz ','')} · {e.staffType==='backoffice'?'Back Office':'Showroom'}</div>
                        <div style={{fontSize:'0.65rem',color:'var(--muted)'}}>{shift.start}–{shift.end}</div>
                      </div>
                      <span style={{fontSize:'0.68rem',color:clr,background:clr+'22',padding:'2px 8px',borderRadius:20,whiteSpace:'nowrap',flexShrink:0}}>{lbl}</span>
                      <button onClick={()=>removeEmployee(e.id,e.name)} style={{background:'none',border:'none',color:'var(--muted)',fontSize:'1.1rem',cursor:'pointer',padding:'4px',flexShrink:0,lineHeight:1}}>✕</button>
                    </div>
                  )
                })}
            </div>
          </div>

          <div className="card-pad" style={S.card}>
            <h3 style={S.cardH}>➕ Add Employee</h3>
            <div style={{display:'flex',flexDirection:'column',gap:12}}>
              {[['Full Name','text',newName,setNewName,'e.g. Mohammed Ali'],['Employee ID','text',newId,setNewId,'e.g. EMP-008']].map(([lbl,type,val,set,ph])=>(
                <div key={lbl}>
                  <div style={{fontSize:'0.72rem',color:'var(--muted)',marginBottom:4}}>{lbl}</div>
                  <input type={type} placeholder={ph} value={val} onChange={e=>set(e.target.value)} style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:8,color:'var(--text)',fontFamily:'var(--font-mono)',fontSize:'16px',padding:'12px 14px',width:'100%',outline:'none'}}/>
                </div>
              ))}
              <div>
                <div style={{fontSize:'0.72rem',color:'var(--muted)',marginBottom:4}}>Showroom</div>
                <select value={newRoom} onChange={e=>{setNewRoom(e.target.value);setNewST('showroom')}} style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:8,color:'var(--text)',fontFamily:'var(--font-mono)',fontSize:'16px',padding:'12px 14px',width:'100%',outline:'none'}}>
                  {SHOWROOMS.map(s=><option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <div style={{fontSize:'0.72rem',color:'var(--muted)',marginBottom:4}}>Staff Type</div>
                <select value={newST} onChange={e=>setNewST(e.target.value)} style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:8,color:'var(--text)',fontFamily:'var(--font-mono)',fontSize:'16px',padding:'12px 14px',width:'100%',outline:'none'}}>
                  <option value="showroom">Showroom Staff</option>
                  {newRoom==='Idealz Prime'&&<option value="backoffice">Back Office Staff</option>}
                </select>
              </div>
              <div style={{fontSize:'0.72rem',padding:'8px 12px',background:'rgba(108,99,255,0.1)',borderRadius:8,color:'var(--accent)'}}>
                ⏰ Shift: {getShift(newRoom,newST).start} – {getShift(newRoom,newST).end}
              </div>
              <button style={{...S.btn,background:'var(--accent)',color:'#fff',minHeight:52}} onClick={addEmployee}>➕ Add Employee</button>
            </div>

            <div style={{marginTop:20}}>
              <h3 style={{...S.cardH,marginBottom:10,fontSize:'0.95rem'}}>🏢 Today</h3>
              {SHOWROOMS.map((s,i)=>(
                <div key={s} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 0',borderBottom:'1px solid var(--border)',fontSize:'0.8rem'}}>
                  <span>{ICONS[i]} {s.replace('Idealz ','')}</span>
                  <span style={{color:'var(--accent3)',fontWeight:500}}>{stats.byShowroom?.[s]??0} present</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>}

      {/* ── FP OVERLAY ── */}
      {fpOverlay&&(
        <div style={S.fpOv}>
          <div style={S.fpCircle}>👆</div>
          <div style={{fontFamily:'var(--font-head)',fontSize:'1.1rem',textAlign:'center',padding:'0 20px'}}>{fpLabel}</div>
          <div style={{fontSize:'0.78rem',color:'var(--muted)'}}>Place your finger on the sensor</div>
        </div>
      )}

      {/* ── LEAVE MODAL ── */}
      {leaveModal&&(
        <div style={S.modalBg} onClick={e=>e.target===e.currentTarget&&setLeaveM(false)}>
          <div className="modal-box" style={S.modal}>
            <h3 style={{fontFamily:'var(--font-head)',fontSize:'1.1rem',marginBottom:16}}>🕐 Short Leave Request</h3>
            {[
              ['Employee',<select value={leaveEmp} onChange={e=>setLeaveEmp(e.target.value)} style={mSel}><option value="">— Select —</option>{empForRoom.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select>],
              ['Duration',<select value={leaveDur} onChange={e=>setLeaveDur(e.target.value)} style={mSel}>{[['15','15 min'],['30','30 min'],['45','45 min'],['60','1 hour'],['90','1.5 hrs'],['120','2 hours']].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select>],
              ['Reason',<textarea placeholder="Brief reason…" value={leaveReason} onChange={e=>setLeaveR(e.target.value)} style={{...mSel,resize:'vertical',minHeight:64}}/>],
            ].map(([lbl,el])=>(
              <div key={lbl} style={{marginBottom:12}}>
                <div style={{fontSize:'0.72rem',color:'var(--muted)',marginBottom:4}}>{lbl}</div>
                {el}
              </div>
            ))}
            <div style={{display:'flex',gap:10,marginTop:16}}>
              <button style={{padding:'12px 16px',background:'transparent',color:'var(--muted)',border:'1px solid var(--border)',borderRadius:8,fontFamily:'var(--font-mono)',cursor:'pointer',flexShrink:0}} onClick={()=>setLeaveM(false)}>Cancel</button>
              <button style={{...S.btn,flex:1,background:'var(--accent)',color:'#fff',padding:'12px'}} onClick={submitLeave}>👆 Fingerprint & Submit</button>
            </div>
          </div>
        </div>
      )}

      {/* ── TOAST ── */}
      {toast&&(
        <div style={{...S.toast,borderColor:toast.type==='error'?'var(--accent2)':toast.type==='info'?'var(--accent)':'var(--accent3)'}}>
          {toast.msg}
        </div>
      )}

      {/* ── MOBILE BOTTOM NAV ── */}
      <div className="bottom-nav">
        <div className="bottom-nav-inner">
          {[
            {t:'checkin', icon:'👆', label:'Check In'},
            {t:'report',  icon:'📊', label:'Reports'},
            {t:'admin',   icon:'👥', label:'Admin'},
            {t:'analytics',icon:'📈',label:'Analytics', href:'/analytics'},
          ].map(({t,icon,label,href})=>(
            href
              ? <a key={t} href={href} className="bnav-btn"><span className="bnav-icon">{icon}</span><span>{label}</span></a>
              : <button key={t} className={`bnav-btn${tab===t?' on':''}`} onClick={()=>setTab(t)}><span className="bnav-icon">{icon}</span><span>{label}</span></button>
          ))}
        </div>
      </div>

    </div>
  </>)
}

const mSel={background:'var(--surface)',border:'1px solid var(--border)',borderRadius:8,color:'var(--text)',fontFamily:'var(--font-mono)',fontSize:'16px',padding:'10px 14px',width:'100%',outline:'none'}

function badge(type){
  const m={arrive:['rgba(67,233,123,0.15)','#43e97b'],depart:['rgba(255,101,132,0.15)','#ff6584'],leave:['rgba(247,201,72,0.15)','#f7c948'],return:['rgba(108,99,255,0.15)','#6c63ff']}
  const [bg,color]=m[type]||['rgba(107,107,138,0.2)','#6b6b8a']
  return {display:'inline-block',padding:'2px 8px',borderRadius:20,fontSize:'0.7rem',background:bg,color,whiteSpace:'nowrap'}
}

const S={
  nav:{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'0 32px',height:64,borderBottom:'1px solid var(--border)',background:'rgba(10,10,15,0.95)',backdropFilter:'blur(12px)',position:'sticky',top:0,zIndex:100,fontFamily:'var(--font-mono)'},
  brand:{fontFamily:'var(--font-head)',fontSize:'1.05rem',fontWeight:800,letterSpacing:'-0.02em',display:'flex',alignItems:'center',gap:10},
  dot:{width:8,height:8,borderRadius:'50%',background:'var(--accent)',boxShadow:'0 0 12px var(--accent)'},
  tabs:{display:'flex',gap:4,background:'var(--surface)',padding:4,borderRadius:10,border:'1px solid var(--border)'},
  tab:{padding:'6px 16px',borderRadius:7,fontFamily:'var(--font-mono)',fontSize:'0.78rem',cursor:'pointer',border:'none',background:'transparent',color:'var(--muted)'},
  tabOn:{background:'var(--accent)',color:'#fff',boxShadow:'0 0 16px rgba(108,99,255,0.4)'},
  page:{position:'relative',zIndex:1,padding:'24px 24px 100px',maxWidth:1100,margin:'0 auto'},
  h1:{fontFamily:'var(--font-head)',fontSize:'1.5rem',fontWeight:800,marginBottom:6},
  sub:{fontSize:'0.76rem',color:'var(--muted)',marginBottom:24},
  roomGrid:{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:14,marginBottom:24},
  roomCard:{background:'var(--card)',border:'2px solid var(--border)',borderRadius:14,padding:18,cursor:'pointer',transition:'all .2s',textAlign:'center'},
  roomOn:{borderColor:'var(--accent)',background:'rgba(108,99,255,0.1)',boxShadow:'0 0 20px rgba(108,99,255,0.2)'},
  grid2:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16},
  card:{background:'var(--card)',border:'1px solid var(--border)',borderRadius:14,padding:24},
  cardH:{fontFamily:'var(--font-head)',fontSize:'1rem',marginBottom:16},
  sel:{width:'100%',padding:'12px 14px',background:'var(--surface)',border:'1px solid var(--border)',borderRadius:10,color:'var(--text)',fontFamily:'var(--font-mono)',fontSize:'16px',marginBottom:12,cursor:'pointer'},
  btn:{width:'100%',padding:15,borderRadius:12,border:'none',fontFamily:'var(--font-head)',fontWeight:700,fontSize:'0.95rem',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:8,transition:'all .2s'},
  logBox:{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:10,padding:12,maxHeight:200,overflowY:'auto'},
  logRow:{display:'flex',alignItems:'flex-start',gap:8,padding:'7px 0',borderBottom:'1px solid var(--border)',fontSize:'0.76rem'},
  filters:{display:'flex',gap:10,marginBottom:20,flexWrap:'wrap',alignItems:'center'},
  exportBtn:{padding:'10px 16px',background:'var(--accent)',color:'#fff',border:'none',borderRadius:8,fontFamily:'var(--font-head)',fontWeight:700,cursor:'pointer',fontSize:'0.8rem',whiteSpace:'nowrap'},
  statsGrid:{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginBottom:20},
  statCard:{background:'var(--card)',border:'1px solid var(--border)',borderRadius:12,padding:16},
  fpOv:{position:'fixed',inset:0,background:'rgba(0,0,0,0.85)',zIndex:300,display:'flex',alignItems:'center',justifyContent:'center',flexDirection:'column',gap:20},
  fpCircle:{width:120,height:120,borderRadius:'50%',border:'3px solid var(--accent)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:'3rem',boxShadow:'0 0 40px rgba(108,99,255,0.5)'},
  modalBg:{position:'fixed',inset:0,background:'rgba(0,0,0,0.75)',backdropFilter:'blur(4px)',zIndex:200,display:'flex',alignItems:'center',justifyContent:'center',padding:16},
  modal:{background:'var(--card)',border:'1px solid var(--border)',borderRadius:18,padding:24,width:400,maxWidth:'100%'},
  toast:{position:'fixed',bottom:80,right:16,zIndex:999,background:'var(--card)',border:'1px solid',borderRadius:12,padding:'12px 18px',fontSize:'0.82rem',maxWidth:'calc(100vw - 32px)',fontFamily:'var(--font-mono)'},
}
