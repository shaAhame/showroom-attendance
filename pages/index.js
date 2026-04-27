import { useState, useEffect } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import { db } from '../lib/firebase'
import { collection, getDocs, addDoc, deleteDoc, doc, query, orderBy, where, updateDoc } from 'firebase/firestore'
import { getSession, clearSession, canViewReports, canManageEmployees, canViewAnalytics, getAllowedShowroom } from '../lib/auth'

const SHOWROOMS = ['Idealz Marino', 'Idealz Libert Plaza', 'Idealz Prime']
const ICONS     = ['🏛️','🏬','🏪']
const COLORS    = ['#6c63ff','#ff6584','#43e97b','#f7c948','#38b6ff','#ff9a4a','#a78bfa','#34d399']
const ROLES     = ['employee','manager','admin']
const ROLE_LABELS = { employee:'Employee', manager:'Manager', admin:'Admin / HR', backoffice:'Back Office' }
const SHIFTS = {
  'Idealz Marino':       { showroom:{ start:'10:00', end:'20:00' } },
  'Idealz Libert Plaza': { showroom:{ start:'10:00', end:'19:00' } },
  'Idealz Prime':        { showroom:{ start:'09:45', end:'19:30' }, backoffice:{ start:'09:30', end:'18:30' } },
}
// ── GPS Coordinates for each showroom (50m radius) ──────────────────────────
const SHOWROOM_LOCATIONS = {
  'Idealz Marino':       { lat: 6.9044,    lng: 79.8553,   radius: 50 },
  'Idealz Libert Plaza': { lat: 6.9112649, lng: 79.8515544, radius: 50 },
  'Idealz Prime':        { lat: 6.8912671, lng: 79.8560789, radius: 50 },
}

// Haversine formula — distance between two GPS points in meters
function getDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000 // Earth radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) *
            Math.sin(dLng/2) * Math.sin(dLng/2)
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
}

// Returns {allowed: bool, distance: number, message: string}
function checkInsideShowroom(showroom, userLat, userLng) {
  const loc = SHOWROOM_LOCATIONS[showroom]
  if (!loc) return { allowed: true, distance: 0, message: '' }
  const dist = Math.round(getDistance(loc.lat, loc.lng, userLat, userLng))
  if (dist <= loc.radius) {
    return { allowed: true, distance: dist, message: `✅ You are inside ${showroom} (${dist}m)` }
  }
  return { allowed: false, distance: dist, message: `❌ You are ${dist}m away from ${showroom}. You must be within 50m to check in.` }
}

// Get current GPS position as a Promise
function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('GPS not supported on this device'))
      return
    }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      err => reject(err),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    )
  })
}

function getShift(showroom, staffType='showroom') {
  const sh=SHIFTS[showroom]; if(!sh) return {start:'09:00',end:'18:00'}
  return sh[staffType]||sh.showroom
}
function today()   { return new Date().toISOString().split('T')[0] }
function nowTime() { return new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'}) }
function initials(name='') { return name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase() }

// Biometric via WebAuthn — optional, skipped if device has no sensor
async function checkBiometricAvailable() {
  try {
    if (!window.PublicKeyCredential) return false
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
  } catch { return false }
}

async function verifyBiometric(empId) {
  const hasBio = await checkBiometricAvailable()
  if (!hasBio) return true // no sensor on device — PIN only is enough

  const challenge = new Uint8Array(32); crypto.getRandomValues(challenge)
  const key = `idealz_cred_${empId}`
  try {
    const existing = localStorage.getItem(key)
    if (existing) {
      const credId = Uint8Array.from(atob(existing), c=>c.charCodeAt(0))
      await navigator.credentials.get({
        publicKey:{ challenge, timeout:30000, userVerification:'required', rpId:location.hostname, allowCredentials:[{type:'public-key',id:credId}] }
      })
    } else {
      const cred = await navigator.credentials.create({
        publicKey:{
          challenge,
          rp:{ name:'Idealz Attendance', id:location.hostname },
          user:{ id:new TextEncoder().encode(empId), name:empId, displayName:empId },
          pubKeyCredParams:[{type:'public-key',alg:-7},{type:'public-key',alg:-257}],
          timeout:30000,
          authenticatorSelection:{ authenticatorAttachment:'platform', userVerification:'required', residentKey:'preferred' }
        }
      })
      localStorage.setItem(key, btoa(String.fromCharCode(...new Uint8Array(cred.rawId))))
    }
    return true
  } catch(e) {
    if (e.name==='NotAllowedError') return false
    return true
  }
}

async function fbGetEmployees() {
  try { const s=await getDocs(query(collection(db,'employees'),orderBy('name'))); return s.docs.map(d=>({id:d.id,...d.data()})) }
  catch { const s=await getDocs(collection(db,'employees')); return s.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>a.name.localeCompare(b.name)) }
}
async function fbGetTodayRecords(showroom=null) {
  try {
    const constraints=[where('date','==',today())]
    if(showroom) constraints.push(where('showroom','==',showroom))
    const s=await getDocs(query(collection(db,'records'),...constraints))
    return s.docs.map(d=>({id:d.id,...d.data()}))
  } catch {
    const s=await getDocs(collection(db,'records'))
    let data=s.docs.map(d=>({id:d.id,...d.data()})).filter(r=>r.date===today())
    if(showroom) data=data.filter(r=>r.showroom===showroom)
    return data
  }
}

export default function Home() {
  const router = useRouter()
  const [session, setSession]   = useState(null)
  const [mounted, setMounted]   = useState(false)
  const [tab, setTab]           = useState('checkin')
  const [employees, setEmps]    = useState([])
  const [todayRecs, setTodayRecs] = useState([])
  const [stats, setStats]       = useState({})
  const [selRoom, setSelRoom]   = useState('')
  const [log, setLog]           = useState([])
  const [fpOverlay, setFpOv]    = useState(false)
  const [gpsStatus, setGpsStatus] = useState('') // 'checking' | 'ok' | 'fail'
  const [fpLabel, setFpLabel]   = useState('')
  const [leaveModal, setLeaveM] = useState(false)
  const [leaveEmp, setLeaveEmp] = useState('')
  const [leaveDur, setLeaveDur] = useState('30')
  const [leaveReason, setLeaveR]= useState('')
  const [toast, setToast]       = useState(null)
  const [clock, setClock]       = useState('')
  const [clockDate, setClkDate] = useState('')
  const [allRecs, setAllRecs]   = useState([])
  const [loading, setLoading]   = useState(false)
  const [fRoom, setFRoom]       = useState('')
  const [fEmp, setFEmp]         = useState('')
  const [fDate, setFDate]       = useState('')
  const [fType, setFType]       = useState('')
  // Admin: add employee
  const [newName, setNewName]   = useState('')
  const [newId, setNewId]       = useState('')
  const [newRoom, setNewRoom]   = useState('Idealz Marino')
  const [newST, setNewST]       = useState('showroom')
  const [newRole, setNewRole]   = useState('employee')
  const [newPin, setNewPin]     = useState('')
  // Admin: edit PIN
  const [editPinId, setEditPinId]   = useState(null)
  const [editPinVal, setEditPinVal] = useState('')

  // ── Auth guard ────────────────────────────────────────────────────────────
  useEffect(() => {
    setMounted(true)
    const s = getSession()
    if (!s) { router.replace('/login'); return }
    setSession(s)
    // Lock manager to their showroom
    if (s.role === 'manager') setSelRoom(s.showroom)
    if (s.role === 'employee') setSelRoom(s.showroom)
  }, [])

  useEffect(() => {
    const t=setInterval(()=>{
      const n=new Date()
      setClock(n.toLocaleTimeString('en-GB'))
      setClkDate(n.toLocaleDateString('en-GB',{weekday:'short',day:'2-digit',month:'short',year:'numeric'}))
    },1000); return()=>clearInterval(t)
  },[])

  useEffect(() => {
    if (!session) return
    loadAll()
  }, [session])

  useEffect(() => { if(session && tab==='report') loadReports() }, [tab, fRoom, fEmp, fDate, fType])

  async function loadAll() {
    const allowedRoom = getAllowedShowroom(session)
    const [emps, recs] = await Promise.all([fbGetEmployees(), fbGetTodayRecords(allowedRoom)])
    // Employees: filter by role
    const visibleEmps = session.role==='employee'
      ? emps.filter(e=>e.empId===session.empId) // employee sees only themselves
      : session.role==='manager'
        ? emps.filter(e=>e.showroom===session.showroom) // manager sees their showroom
        : emps // admin sees all
    setEmps(visibleEmps)
    setTodayRecs(recs)
    computeStats(visibleEmps, recs)
  }

  function computeStats(emps, recs) {
    const arrived  = new Set(recs.filter(r=>r.type==='arrive').map(r=>r.empId)).size
    const departed = new Set(recs.filter(r=>r.type==='depart').map(r=>r.empId)).size
    const onLeave  = new Set(recs.filter(r=>r.type==='leave').map(r=>r.empId)).size
    const byShowroom = {}
    SHOWROOMS.forEach(s=>{ byShowroom[s]=new Set(recs.filter(r=>r.showroom===s&&r.type==='arrive').map(r=>r.empId)).size })
    setStats({arrived,departed,onLeave,byShowroom})
  }

  function showToast(msg,type='success'){setToast({msg,type});setTimeout(()=>setToast(null),3200)}

  // Employee can only check in/out for themselves
  const canSelectEmp = session?.role !== 'employee'
  const empForRoom   = selRoom ? employees.filter(e=>e.showroom===selRoom) : employees
  // For employee role: auto-select themselves
  const autoEmpId    = session?.role==='employee' ? employees[0]?.id : ''

  async function doAction(type, empOverrideId=null) {
    const eid = empOverrideId || (session?.role==='employee' ? employees[0]?.id : null)
    if (!eid && session?.role!=='employee') return showToast('Select an employee.','error')
    if (!selRoom) return showToast('Select a showroom first.','error')
    const emp = employees.find(e=>e.id===eid) || employees[0]
    if (!emp) return showToast('Employee not found.','error')

    // ── Step 1: GPS Location Check ──────────────────────────────────────────
    setGpsStatus('checking')
    showToast('📍 Checking your location…','info')
    try {
      const pos = await getCurrentPosition()
      const check = checkInsideShowroom(selRoom, pos.lat, pos.lng)
      if (!check.allowed) {
        setGpsStatus('fail')
        showToast(check.message, 'error')
        setTimeout(()=>setGpsStatus(''), 3000)
        return
      }
      setGpsStatus('ok')
    } catch(e) {
      setGpsStatus('fail')
      if (e.code === 1) { // Permission denied
        showToast('❌ Location access denied. Please allow GPS in your browser settings.','error')
      } else if (e.code === 2) {
        showToast('❌ GPS signal not available. Try moving near a window.','error')
      } else {
        showToast('❌ Could not get your location. Please try again.','error')
      }
      setTimeout(()=>setGpsStatus(''), 3000)
      return
    }

    // ── Step 2: Face ID / Biometric ─────────────────────────────────────────
    setFpLabel(type==='arrive'?`Verifying arrival — ${emp.name}`:`Verifying departure — ${emp.name}`)
    setFpOv(true)
    const ok = await verifyBiometric(emp.empId)
    setFpOv(false)
    setGpsStatus('')
    if (!ok) return showToast('Face ID / fingerprint did not match.','error')

    // ── Step 3: Save record ──────────────────────────────────────────────────
    const rec={empId:emp.empId,empName:emp.name,showroom:selRoom,type,date:today(),time:nowTime(),reason:'',duration:0}
    await addDoc(collection(db,'records'),{...rec,createdAt:Date.now()})
    setLog(p=>[{...rec,id:Date.now()},...p])
    setTodayRecs(p=>{const n=[...p,rec];computeStats(employees,n);return n})
    showToast(`${type==='arrive'?'✅ Arrived':'🔴 Departed'}: ${emp.name}`)
  }

  async function submitLeave() {
    const eid = session?.role==='employee' ? employees[0]?.id : leaveEmp
    if (!eid) return showToast('Select an employee.','error')
    if (!selRoom) return showToast('Select a showroom first.','error')
    const emp = employees.find(e=>e.id===eid)||employees[0]
    if (!emp) return

    // GPS check
    setGpsStatus('checking')
    showToast('📍 Checking your location…','info')
    try {
      const pos = await getCurrentPosition()
      const check = checkInsideShowroom(selRoom, pos.lat, pos.lng)
      if (!check.allowed) {
        setGpsStatus('fail')
        showToast(check.message,'error')
        setTimeout(()=>setGpsStatus(''),3000)
        return
      }
      setGpsStatus('ok')
    } catch(e) {
      setGpsStatus('fail')
      showToast('❌ Could not get your location. Please allow GPS access.','error')
      setTimeout(()=>setGpsStatus(''),3000)
      return
    }

    setFpLabel(`Short leave — ${emp.name}`); setFpOv(true)
    const ok = await verifyBiometric(emp.empId)
    setFpOv(false)
    setGpsStatus('')
    if (!ok) return showToast('Face ID / fingerprint did not match.','error')
    const rec={empId:emp.empId,empName:emp.name,showroom:selRoom,type:'leave',date:today(),time:nowTime(),reason:leaveReason||'Short leave',duration:parseInt(leaveDur)}
    await addDoc(collection(db,'records'),{...rec,createdAt:Date.now()})
    setLog(p=>[{...rec,id:Date.now()},...p])
    setTodayRecs(p=>{const n=[...p,rec];computeStats(employees,n);return n})
    setLeaveM(false); setLeaveR('')
    showToast(`🕐 Short leave: ${emp.name} (~${leaveDur} min)`)
  }

  async function loadReports() {
    setLoading(true)
    try {
      const snap=await getDocs(collection(db,'records'))
      let data=snap.docs.map(d=>({id:d.id,...d.data()}))
      // Manager can only see their showroom
      if (session?.role==='manager') data=data.filter(r=>r.showroom===session.showroom)
      if (fRoom)  data=data.filter(r=>r.showroom===fRoom)
      if (fEmp)   data=data.filter(r=>r.empId===fEmp)
      if (fDate)  data=data.filter(r=>r.date===fDate)
      if (fType)  data=data.filter(r=>r.type===fType)
      setAllRecs(data.sort((a,b)=>b.createdAt-a.createdAt))
    } catch { showToast('Error loading records.','error') }
    setLoading(false)
  }

  function exportCSV() {
    const rows=[['Employee','Showroom','Type','Time','Date','Reason','Duration(min)']]
    allRecs.forEach(r=>rows.push([r.empName,r.showroom,r.type,r.time,r.date,r.reason||'',r.duration||'']))
    const csv=rows.map(r=>r.map(c=>`"${c}"`).join(',')).join('\n')
    const a=document.createElement('a');a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv)
    a.download=`idealz-${today()}.csv`;a.click()
  }

  // ── Admin: add employee ───────────────────────────────────────────────────
  async function addEmployee() {
    if (!newName||!newId) return showToast('Fill in name and Employee ID.','error')
    if (!newPin||newPin.length<4) return showToast('PIN must be at least 4 digits.','error')
    if (!/^\d+$/.test(newPin)) return showToast('PIN must be digits only.','error')
    const allEmps=await fbGetEmployees()
    if (allEmps.find(e=>e.empId===newId)) return showToast('Employee ID already exists.','error')
    const color=COLORS[Math.floor(Math.random()*COLORS.length)]
    try {
      const ref=await addDoc(collection(db,'employees'),{empId:newId,name:newName,showroom:newRoom,staffType:newST,role:newRole,pin:newPin,color,createdAt:Date.now()})
      showToast(`✅ ${newName} added!`)
      setNewName('');setNewId('');setNewPin('')
      loadAll()
    } catch { showToast('Error adding employee.','error') }
  }

  async function removeEmployee(id, name) {
    try { await deleteDoc(doc(db,'employees',id)); showToast(`🗑️ ${name} removed.`); loadAll() }
    catch { showToast('Error removing.','error') }
  }

  async function savePinEdit(empDocId) {
    if (!editPinVal||editPinVal.length<4) return showToast('PIN must be at least 4 digits.','error')
    if (!/^\d+$/.test(editPinVal)) return showToast('PIN must be digits only.','error')
    try {
      await updateDoc(doc(db,'employees',empDocId),{ pin: editPinVal })
      showToast('✅ PIN updated!'); setEditPinId(null); setEditPinVal(''); loadAll()
    } catch { showToast('Error updating PIN.','error') }
  }

  function logout() { clearSession(); router.replace('/login') }

  if (!mounted || !session) return <div style={{color:'#e8e8f0',textAlign:'center',padding:60,fontFamily:'var(--font-mono)'}}>Loading…</div>

  const typeLabel={arrive:'Arrive',depart:'Depart',leave:'Short Leave',return:'Return'}
  const logColors={arrive:'#43e97b',depart:'#ff6584',leave:'#f7c948',return:'#6c63ff'}
  const roleColor={employee:'#6b6b8a',manager:'#38b6ff',admin:'#a78bfa',backoffice:'#f7c948'}

  return (<>
    <Head>
      <title>Idealz Attendance</title>
      <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/>
      <meta name="theme-color" content="#0a0a0f"/>
      <meta name="apple-mobile-web-app-capable" content="yes"/>
    </Head>
    <div style={{position:'relative',zIndex:1}}>

      {/* ── NAV ── */}
      <nav className="nav-bar" style={S.nav}>
        <div style={S.brand}><div style={S.dot}/>IDEALZ · ATTEND</div>
        <div className="desktop-tabs" style={S.tabs}>
          <button style={{...S.tab,...(tab==='checkin'?S.tabOn:{})}} onClick={()=>setTab('checkin')}>Check In/Out</button>
          {canViewReports(session) && <button style={{...S.tab,...(tab==='report'?S.tabOn:{})}} onClick={()=>setTab('report')}>Reports</button>}
          {canManageEmployees(session) && <button style={{...S.tab,...(tab==='admin'?S.tabOn:{})}} onClick={()=>setTab('admin')}>Admin</button>}
          {canViewAnalytics(session) && <a href="/analytics" style={{...S.tab,textDecoration:'none',display:'flex',alignItems:'center',color:'var(--muted)'}}>Analytics</a>}
        </div>
        {/* User chip + logout */}
        <div style={{display:'flex',alignItems:'center',gap:10}}>
          <div className="desktop-clock" style={{textAlign:'right'}}>
            <div style={{fontSize:'0.8rem',color:'var(--text)'}}>{clock}</div>
            <div style={{fontSize:'0.68rem',color:'var(--muted)'}}>{clockDate}</div>
          </div>
          <div style={{display:'flex',alignItems:'center',gap:8,padding:'6px 12px',background:'var(--surface)',borderRadius:20,border:'1px solid var(--border)'}}>
            <div style={{width:28,height:28,borderRadius:'50%',background:session.color+'33',color:session.color,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:700,fontSize:'0.72rem'}}>
              {initials(session.name)}
            </div>
            <div className="desktop-clock">
              <div style={{fontSize:'0.78rem',color:'var(--text)',fontWeight:500}}>{session.name.split(' ')[0]}</div>
              <div style={{fontSize:'0.65rem',color:roleColor[session.role]||'var(--muted)'}}>{ROLE_LABELS[session.role]}</div>
            </div>
            <button onClick={logout} style={{background:'none',border:'none',color:'var(--muted)',cursor:'pointer',fontSize:'0.72rem',marginLeft:4,padding:'2px 6px',borderRadius:4,transition:'color .2s'}}
              onMouseOver={e=>e.target.style.color='var(--accent2)'} onMouseOut={e=>e.target.style.color='var(--muted)'}>
              Sign out
            </button>
          </div>
        </div>
      </nav>

      {/* ── ROLE BANNER ── */}
      {session.role === 'employee' && (
        <div style={{background:'rgba(108,99,255,0.08)',borderBottom:'1px solid rgba(108,99,255,0.2)',padding:'8px 24px',fontSize:'0.76rem',color:'var(--accent)',textAlign:'center'}}>
          👋 Welcome, {session.name} · You can check in and out for yourself only
        </div>
      )}
      {session.role === 'manager' && (
        <div style={{background:'rgba(56,182,255,0.08)',borderBottom:'1px solid rgba(56,182,255,0.2)',padding:'8px 24px',fontSize:'0.76rem',color:'#38b6ff',textAlign:'center'}}>
          👔 Manager view · {session.showroom}
        </div>
      )}

      {/* ── CHECK IN/OUT ── */}
      {tab==='checkin' && <div className="page-content" style={S.page}>
        <div className="page-h1" style={S.h1}>
          {session.role==='employee' ? `Hi, ${session.name.split(' ')[0]}! 👋` : 'Check In / Out'}
        </div>
        <div style={S.sub}>
          {session.role==='employee' ? 'Tap below to check in or out' : 'Select showroom → employee → biometric'}
        </div>

        {/* Showroom cards — employee & manager locked to their showroom */}
        <div className="room-grid" style={S.roomGrid}>
          {SHOWROOMS.map((s,i)=>{
            const locked = (session.role==='employee'||session.role==='manager') && s!==session.showroom
            return (
              <div key={s} style={{...S.roomCard,...(selRoom===s?S.roomOn:{}),opacity:locked?0.35:1,cursor:locked?'not-allowed':'pointer'}}
                onClick={()=>{ if(!locked){setSelRoom(s)} }}>
                <div style={{fontSize:'1.8rem',marginBottom:6}}>{ICONS[i]}</div>
                <div style={{fontFamily:'var(--font-head)',fontWeight:700,fontSize:'0.9rem',marginBottom:2}}>{s}</div>
                <div style={{fontSize:'0.68rem',color:'var(--muted)'}}>{stats.byShowroom?.[s]??0} in today</div>
                {locked && <div style={{fontSize:'0.62rem',color:'var(--muted)',marginTop:4}}>🔒 No access</div>}
              </div>
            )
          })}
        </div>

        {/* GPS Status Bar */}
        {gpsStatus && (
          <div style={{
            marginBottom:16, padding:'10px 16px', borderRadius:10,
            background: gpsStatus==='checking'?'rgba(108,99,255,0.1)': gpsStatus==='ok'?'rgba(67,233,123,0.1)':'rgba(255,101,132,0.1)',
            border: `1px solid ${gpsStatus==='checking'?'rgba(108,99,255,0.3)':gpsStatus==='ok'?'rgba(67,233,123,0.3)':'rgba(255,101,132,0.3)'}`,
            display:'flex', alignItems:'center', gap:10, fontSize:'0.82rem',
            color: gpsStatus==='checking'?'var(--accent)':gpsStatus==='ok'?'var(--accent3)':'var(--accent2)'
          }}>
            <span style={{fontSize:'1.1rem'}}>{gpsStatus==='checking'?'📍':gpsStatus==='ok'?'✅':'❌'}</span>
            <span>{gpsStatus==='checking'?'Getting your GPS location…':gpsStatus==='ok'?'Location verified — you are at the showroom':'Location check failed'}</span>
          </div>
        )}

        <div className="action-grid" style={S.grid2}>
          <div className="card-pad" style={S.card}>
            <h3 style={S.cardH}>Arrival / Departure</h3>
            {!selRoom && <div style={S.warnBox}>👆 Select your showroom above first</div>}

            {/* Employee dropdown — hidden for employee role */}
            {session.role !== 'employee' && (
              <select style={S.sel} value={leaveEmp} onChange={e=>setLeaveEmp(e.target.value)} disabled={!selRoom}>
                <option value="">— Select Employee —</option>
                {empForRoom.map(e=><option key={e.id} value={e.id}>{e.name} · {ROLE_LABELS[e.staffType]||''}</option>)}
              </select>
            )}

            {/* For employee role: show their own info */}
            {session.role === 'employee' && employees[0] && (
              <div style={{padding:'10px 14px',background:'var(--surface)',borderRadius:10,border:'1px solid var(--border)',marginBottom:12,display:'flex',alignItems:'center',gap:10}}>
                <div style={{width:34,height:34,borderRadius:'50%',background:session.color+'33',color:session.color,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:700,fontSize:'0.78rem'}}>
                  {initials(session.name)}
                </div>
                <div>
                  <div style={{fontSize:'0.85rem',fontWeight:500}}>{session.name}</div>
                  <div style={{fontSize:'0.7rem',color:'var(--muted)'}}>{getShift(session.showroom,session.staffType).start} – {getShift(session.showroom,session.staffType).end}</div>
                </div>
              </div>
            )}

            <button className="fp-btn" style={{...S.btn,background:'linear-gradient(135deg,#43e97b,#38f9d7)',color:'#0a0a0f',marginBottom:10,opacity:selRoom?1:0.5}}
              onClick={()=>{ const eid=session.role==='employee'?employees[0]?.id:leaveEmp; doAction('arrive',eid) }}>
              👤 Face ID — Arrive
            </button>
            <button className="fp-btn" style={{...S.btn,background:'linear-gradient(135deg,#ff6584,#ff9a4a)',color:'#0a0a0f',marginBottom:10,opacity:selRoom?1:0.5}}
              onClick={()=>{ const eid=session.role==='employee'?employees[0]?.id:leaveEmp; doAction('depart',eid) }}>
              👤 Face ID — Depart
            </button>
            <button className="fp-btn" style={{...S.btn,background:'linear-gradient(135deg,#f7c948,#ff9a4a)',color:'#0a0a0f',opacity:selRoom?1:0.5}}
              onClick={()=>{ if(!selRoom) return showToast('Select a showroom first.','error'); setLeaveM(true) }}>
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
                    <span style={{color:'var(--muted)',fontSize:'0.7rem',whiteSpace:'nowrap'}}>{r.time}</span>
                    <span style={{fontSize:'0.74rem',overflow:'hidden',textOverflow:'ellipsis'}}>{r.empName.split(' ')[0]} · {typeLabel[r.type]}{r.duration?` (${r.duration}m)`:''}</span>
                  </div>
                ))}
            </div>
          </div>
        </div>
      </div>}

      {/* ── REPORTS (Manager + Admin only) ── */}
      {tab==='report' && canViewReports(session) && <div className="page-content" style={S.page}>
        <div className="page-h1" style={S.h1}>Reports</div>
        <div style={S.sub}>{session.role==='manager'?`${session.showroom} only`:'All showrooms'}</div>

        <div className="filters-row" style={S.filters}>
          {session.role==='admin' && (
            <select style={{...S.sel,width:'auto',minWidth:130}} value={fRoom} onChange={e=>setFRoom(e.target.value)}>
              <option value="">All Showrooms</option>
              {SHOWROOMS.map(s=><option key={s} value={s}>{s.replace('Idealz ','')}</option>)}
            </select>
          )}
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
          {loading ? <div style={{textAlign:'center',padding:32,color:'var(--muted)'}}>Loading…</div>
            : <table style={{width:'100%',borderCollapse:'collapse',fontSize:'0.78rem',minWidth:560}}>
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
                      <td style={{padding:'9px 10px',whiteSpace:'nowrap'}}>{r.empName?.split(' ')[0]}</td>
                      <td style={{padding:'9px 10px',color:'var(--muted)',fontSize:'0.7rem',whiteSpace:'nowrap'}}>{r.showroom?.replace('Idealz ','')}</td>
                      <td style={{padding:'9px 10px'}}><span style={badge(r.type)}>{typeLabel[r.type]||r.type}</span></td>
                      <td style={{padding:'9px 10px',whiteSpace:'nowrap'}}>{r.time}</td>
                      <td style={{padding:'9px 10px',color:'var(--muted)',whiteSpace:'nowrap'}}>{r.date}</td>
                      <td style={{padding:'9px 10px',color:'var(--muted)',maxWidth:120,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r.reason||'—'}</td>
                      <td style={{padding:'9px 10px',color:'var(--muted)',whiteSpace:'nowrap'}}>{r.duration?`${r.duration}m`:'—'}</td>
                    </tr>
                  ))}
              </tbody>
            </table>}
        </div>
      </div>}

      {/* ── ADMIN (Admin only) ── */}
      {tab==='admin' && canManageEmployees(session) && <div className="page-content" style={S.page}>
        <div className="page-h1" style={S.h1}>Admin Panel</div>
        <div style={S.sub}>Manage employees, roles and PINs</div>
        <div className="admin-grid" style={S.grid2}>

          {/* Employee list */}
          <div className="card-pad" style={S.card}>
            <h3 style={S.cardH}>👥 All Employees ({employees.length})</h3>
            <div style={{display:'flex',flexDirection:'column',gap:8,maxHeight:520,overflowY:'auto'}}>
              {employees.map(e=>{
                const recs=todayRecs.filter(r=>r.empId===e.empId)
                const last=[...recs].sort((a,b)=>(b.createdAt||0)-(a.createdAt||0))[0]
                const sm={arrive:['Present','#43e97b'],depart:['Departed','#ff6584'],leave:['On Leave','#f7c948'],return:['Returned','#6c63ff']}
                const [lbl,clr]=(last&&sm[last.type])||['Not in','#6b6b8a']
                const shift=getShift(e.showroom,e.staffType)
                const isEditing = editPinId===e.id
                return (
                  <div key={e.id} style={{background:'var(--surface)',borderRadius:10,border:'1px solid var(--border)',overflow:'hidden'}}>
                    <div style={{display:'flex',alignItems:'center',gap:10,padding:'10px 12px'}}>
                      <div style={{width:36,height:36,borderRadius:'50%',background:e.color+'22',color:e.color,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:700,fontSize:'0.78rem',flexShrink:0}}>{initials(e.name)}</div>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:'0.82rem',fontWeight:500,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{e.name}</div>
                        <div style={{fontSize:'0.68rem',color:'var(--muted)'}}>{e.empId} · {e.showroom.replace('Idealz ','')} · <span style={{color:roleColor[e.role]||'var(--muted)'}}>{ROLE_LABELS[e.role]||e.role}</span></div>
                        <div style={{fontSize:'0.64rem',color:'var(--muted)'}}>{shift.start}–{shift.end} · PIN: {'•'.repeat(e.pin?.length||4)}</div>
                      </div>
                      <span style={{fontSize:'0.66rem',color:clr,background:clr+'22',padding:'2px 7px',borderRadius:20,whiteSpace:'nowrap',flexShrink:0}}>{lbl}</span>
                    </div>
                    {/* Actions row */}
                    <div style={{display:'flex',gap:6,padding:'6px 12px 10px',borderTop:'1px solid var(--border)'}}>
                      <button onClick={()=>{ setEditPinId(isEditing?null:e.id); setEditPinVal('') }}
                        style={{flex:1,padding:'6px',background:'rgba(108,99,255,0.1)',border:'1px solid rgba(108,99,255,0.3)',borderRadius:6,color:'var(--accent)',fontSize:'0.7rem',cursor:'pointer'}}>
                        {isEditing?'Cancel':'🔑 Change PIN'}
                      </button>
                      <button onClick={()=>removeEmployee(e.id,e.name)}
                        style={{padding:'6px 10px',background:'rgba(255,101,132,0.1)',border:'1px solid rgba(255,101,132,0.2)',borderRadius:6,color:'var(--accent2)',fontSize:'0.7rem',cursor:'pointer'}}>
                        🗑️
                      </button>
                    </div>
                    {/* PIN edit inline */}
                    {isEditing && (
                      <div style={{padding:'0 12px 12px',display:'flex',gap:8,alignItems:'center'}}>
                        <input
                          type="password"
                          inputMode="numeric"
                          placeholder="New PIN (4–6 digits)"
                          value={editPinVal}
                          onChange={e=>setEditPinVal(e.target.value.replace(/\D/g,'').slice(0,6))}
                          maxLength={6}
                          style={{flex:1,padding:'8px 12px',background:'var(--bg)',border:'1px solid var(--border)',borderRadius:6,color:'var(--text)',fontFamily:'var(--font-mono)',fontSize:'14px',outline:'none'}}
                        />
                        <button onClick={()=>savePinEdit(e.id)}
                          style={{padding:'8px 14px',background:'var(--accent)',border:'none',borderRadius:6,color:'#fff',fontSize:'0.72rem',cursor:'pointer',fontWeight:700}}>
                          Save
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* Add employee */}
          <div className="card-pad" style={S.card}>
            <h3 style={S.cardH}>➕ Add Employee</h3>
            <div style={{display:'flex',flexDirection:'column',gap:12}}>
              {[['Full Name',newName,setNewName,'e.g. Mohammed Ali','text'],['Employee ID',newId,setNewId,'e.g. EMP-008','text']].map(([lbl,val,set,ph,type])=>(
                <div key={lbl}>
                  <div style={S.inputLabel}>{lbl}</div>
                  <input type={type} placeholder={ph} value={val} onChange={e=>set(e.target.value)} style={S.adminInput}/>
                </div>
              ))}
              <div>
                <div style={S.inputLabel}>Showroom</div>
                <select value={newRoom} onChange={e=>{setNewRoom(e.target.value);setNewST('showroom')}} style={S.adminInput}>
                  {SHOWROOMS.map(s=><option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <div style={S.inputLabel}>Staff Type</div>
                <select value={newST} onChange={e=>setNewST(e.target.value)} style={S.adminInput}>
                  <option value="showroom">Showroom Staff</option>
                  {newRoom==='Idealz Prime'&&<option value="backoffice">Back Office</option>}
                </select>
              </div>
              <div>
                <div style={S.inputLabel}>Role / Access Level</div>
                <select value={newRole} onChange={e=>setNewRole(e.target.value)} style={S.adminInput}>
                  <option value="employee">Employee — Check in/out only</option>
                  <option value="manager">Manager — See showroom reports</option>
                  <option value="admin">Admin / HR — Full access</option>
                </select>
              </div>
              <div>
                <div style={S.inputLabel}>PIN (4–6 digits)</div>
                <input
                  type="password"
                  inputMode="numeric"
                  placeholder="e.g. 1234"
                  value={newPin}
                  onChange={e=>setNewPin(e.target.value.replace(/\D/g,'').slice(0,6))}
                  maxLength={6}
                  style={S.adminInput}
                />
              </div>
              <div style={{fontSize:'0.7rem',padding:'8px 12px',background:'rgba(108,99,255,0.1)',borderRadius:8,color:'var(--accent)'}}>
                ⏰ Shift: {getShift(newRoom,newST).start} – {getShift(newRoom,newST).end}
              </div>
              <button style={{...S.btn,background:'var(--accent)',color:'#fff',minHeight:50}} onClick={addEmployee}>
                ➕ Add Employee
              </button>
            </div>

            <div style={{marginTop:20}}>
              <h3 style={{...S.cardH,marginBottom:10,fontSize:'0.95rem'}}>🔑 Role Access Guide</h3>
              {[
                {role:'Employee',color:'#6b6b8a',desc:'Check in/out for themselves only'},
                {role:'Manager', color:'#38b6ff',desc:'Reports for their showroom only'},
                {role:'Admin',   color:'#a78bfa',desc:'Full access — all showrooms + admin'},
              ].map(r=>(
                <div key={r.role} style={{display:'flex',gap:10,alignItems:'flex-start',padding:'7px 0',borderBottom:'1px solid var(--border)'}}>
                  <span style={{fontSize:'0.7rem',color:r.color,background:r.color+'22',padding:'2px 8px',borderRadius:20,whiteSpace:'nowrap',marginTop:1,flexShrink:0}}>{r.role}</span>
                  <span style={{fontSize:'0.72rem',color:'var(--muted)'}}>{r.desc}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>}

      {/* FP/Bio overlay */}
      {fpOverlay&&(
        <div style={S.fpOv}>
          <div style={S.fpCircle}>👤</div>
          <div style={{fontFamily:'var(--font-head)',fontSize:'1.1rem',textAlign:'center',padding:'0 20px'}}>{fpLabel}</div>
          <div style={{fontSize:'0.78rem',color:'var(--muted)'}}>Use Face ID or fingerprint sensor</div>
        </div>
      )}

      {/* Leave modal */}
      {leaveModal&&(
        <div style={S.modalBg} onClick={e=>e.target===e.currentTarget&&setLeaveM(false)}>
          <div className="modal-box" style={S.modal}>
            <h3 style={{fontFamily:'var(--font-head)',fontSize:'1.1rem',marginBottom:16}}>🕐 Short Leave Request</h3>
            {session.role!=='employee'&&(
              <div style={{marginBottom:12}}>
                <div style={S.inputLabel}>Employee</div>
                <select value={leaveEmp} onChange={e=>setLeaveEmp(e.target.value)} style={S.adminInput}>
                  <option value="">— Select —</option>
                  {empForRoom.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
              </div>
            )}
            <div style={{marginBottom:12}}>
              <div style={S.inputLabel}>Duration</div>
              <select value={leaveDur} onChange={e=>setLeaveDur(e.target.value)} style={S.adminInput}>
                {[['15','15 min'],['30','30 min'],['45','45 min'],['60','1 hour'],['90','1.5 hrs'],['120','2 hours']].map(([v,l])=><option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div style={{marginBottom:16}}>
              <div style={S.inputLabel}>Reason</div>
              <textarea placeholder="Brief reason…" value={leaveReason} onChange={e=>setLeaveR(e.target.value)} style={{...S.adminInput,resize:'vertical',minHeight:64}}/>
            </div>
            <div style={{display:'flex',gap:10}}>
              <button style={{padding:'12px 16px',background:'transparent',color:'var(--muted)',border:'1px solid var(--border)',borderRadius:8,cursor:'pointer',fontFamily:'var(--font-mono)'}} onClick={()=>setLeaveM(false)}>Cancel</button>
              <button style={{...S.btn,flex:1,background:'var(--accent)',color:'#fff',padding:12}} onClick={submitLeave}>👤 Face ID & Submit</button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast&&(
        <div style={{...S.toast,borderColor:toast.type==='error'?'var(--accent2)':toast.type==='info'?'var(--accent)':'var(--accent3)'}}>
          {toast.msg}
        </div>
      )}

      {/* Mobile bottom nav */}
      <div className="bottom-nav">
        <div className="bottom-nav-inner">
          <button className={`bnav-btn${tab==='checkin'?' on':''}`} onClick={()=>setTab('checkin')}><span className="bnav-icon">👤</span><span>Check In</span></button>
          {canViewReports(session)&&<button className={`bnav-btn${tab==='report'?' on':''}`} onClick={()=>setTab('report')}><span className="bnav-icon">📊</span><span>Reports</span></button>}
          {canManageEmployees(session)&&<button className={`bnav-btn${tab==='admin'?' on':''}`} onClick={()=>setTab('admin')}><span className="bnav-icon">👥</span><span>Admin</span></button>}
          {canViewAnalytics(session)&&<a href="/analytics" className="bnav-btn"><span className="bnav-icon">📈</span><span>Analytics</span></a>}
          <button className="bnav-btn" onClick={logout}><span className="bnav-icon">🚪</span><span>Sign out</span></button>
        </div>
      </div>
    </div>
  </>)
}

function badge(type){
  const m={arrive:['rgba(67,233,123,0.15)','#43e97b'],depart:['rgba(255,101,132,0.15)','#ff6584'],leave:['rgba(247,201,72,0.15)','#f7c948'],return:['rgba(108,99,255,0.15)','#6c63ff']}
  const [bg,color]=m[type]||['rgba(107,107,138,0.2)','#6b6b8a']
  return {display:'inline-block',padding:'2px 8px',borderRadius:20,fontSize:'0.7rem',background:bg,color,whiteSpace:'nowrap'}
}

const S={
  nav:{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'0 24px',height:64,borderBottom:'1px solid var(--border)',background:'rgba(10,10,15,0.95)',backdropFilter:'blur(12px)',position:'sticky',top:0,zIndex:100,fontFamily:'var(--font-mono)',gap:12},
  brand:{fontFamily:'var(--font-head)',fontSize:'1rem',fontWeight:800,letterSpacing:'-0.02em',display:'flex',alignItems:'center',gap:8,flexShrink:0},
  dot:{width:8,height:8,borderRadius:'50%',background:'var(--accent)',boxShadow:'0 0 12px var(--accent)'},
  tabs:{display:'flex',gap:4,background:'var(--surface)',padding:3,borderRadius:10,border:'1px solid var(--border)'},
  tab:{padding:'6px 14px',borderRadius:7,fontFamily:'var(--font-mono)',fontSize:'0.76rem',cursor:'pointer',border:'none',background:'transparent',color:'var(--muted)'},
  tabOn:{background:'var(--accent)',color:'#fff',boxShadow:'0 0 16px rgba(108,99,255,0.4)'},
  page:{position:'relative',zIndex:1,padding:'24px 24px 100px',maxWidth:1100,margin:'0 auto'},
  h1:{fontFamily:'var(--font-head)',fontSize:'1.5rem',fontWeight:800,marginBottom:6},
  sub:{fontSize:'0.76rem',color:'var(--muted)',marginBottom:24},
  roomGrid:{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:12,marginBottom:22},
  roomCard:{background:'var(--card)',border:'2px solid var(--border)',borderRadius:14,padding:16,cursor:'pointer',transition:'all .2s',textAlign:'center'},
  roomOn:{borderColor:'var(--accent)',background:'rgba(108,99,255,0.1)',boxShadow:'0 0 20px rgba(108,99,255,0.2)'},
  grid2:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16},
  card:{background:'var(--card)',border:'1px solid var(--border)',borderRadius:14,padding:22},
  cardH:{fontFamily:'var(--font-head)',fontSize:'1rem',marginBottom:16},
  sel:{width:'100%',padding:'11px 14px',background:'var(--surface)',border:'1px solid var(--border)',borderRadius:10,color:'var(--text)',fontFamily:'var(--font-mono)',fontSize:'16px',marginBottom:12,cursor:'pointer'},
  btn:{width:'100%',padding:14,borderRadius:12,border:'none',fontFamily:'var(--font-head)',fontWeight:700,fontSize:'0.95rem',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:8,transition:'all .2s'},
  logBox:{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:10,padding:12,maxHeight:200,overflowY:'auto'},
  logRow:{display:'flex',alignItems:'flex-start',gap:8,padding:'6px 0',borderBottom:'1px solid var(--border)',fontSize:'0.75rem'},
  filters:{display:'flex',gap:10,marginBottom:20,flexWrap:'wrap',alignItems:'center'},
  exportBtn:{padding:'10px 16px',background:'var(--accent)',color:'#fff',border:'none',borderRadius:8,fontFamily:'var(--font-head)',fontWeight:700,cursor:'pointer',fontSize:'0.8rem',whiteSpace:'nowrap'},
  statsGrid:{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginBottom:20},
  statCard:{background:'var(--card)',border:'1px solid var(--border)',borderRadius:12,padding:16},
  fpOv:{position:'fixed',inset:0,background:'rgba(0,0,0,0.88)',zIndex:300,display:'flex',alignItems:'center',justifyContent:'center',flexDirection:'column',gap:20},
  fpCircle:{width:110,height:110,borderRadius:'50%',border:'3px solid var(--accent)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:'3rem',boxShadow:'0 0 40px rgba(108,99,255,0.5)'},
  modalBg:{position:'fixed',inset:0,background:'rgba(0,0,0,0.75)',backdropFilter:'blur(4px)',zIndex:200,display:'flex',alignItems:'center',justifyContent:'center',padding:16},
  modal:{background:'var(--card)',border:'1px solid var(--border)',borderRadius:18,padding:24,width:400,maxWidth:'100%'},
  toast:{position:'fixed',bottom:80,right:16,zIndex:999,background:'var(--card)',border:'1px solid',borderRadius:12,padding:'12px 18px',fontSize:'0.82rem',maxWidth:'calc(100vw - 32px)',fontFamily:'var(--font-mono)'},
  warnBox:{fontSize:'0.78rem',color:'var(--gold)',marginBottom:12,padding:'8px 12px',background:'rgba(247,201,72,0.1)',borderRadius:8},
  inputLabel:{fontSize:'0.72rem',color:'var(--muted)',marginBottom:5},
  adminInput:{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:8,color:'var(--text)',fontFamily:'var(--font-mono)',fontSize:'16px',padding:'11px 14px',width:'100%',outline:'none'},
}
