import { useState, useEffect } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import { db } from '../lib/firebase'
import { collection, getDocs, addDoc, deleteDoc, doc, query, orderBy, where, updateDoc } from 'firebase/firestore'
import { getSession, clearSession, canViewReports, canManageEmployees, canViewAnalytics, getAllowedShowroom } from '../lib/auth'

const SHOWROOMS = ['Idealz Marino', 'Idealz Liberty Plaza', 'Idealz Prime']
const ICONS     = ['🏛️','🏬','🏪']
const COLORS    = ['#6c63ff','#ff6584','#43e97b','#f7c948','#38b6ff','#ff9a4a','#a78bfa','#34d399']
const ROLES     = ['employee','manager','admin']
const ROLE_LABELS = { employee:'Employee', manager:'Manager', admin:'Admin / HR', backoffice:'Back Office' }
const SHIFTS = {
  'Idealz Marino':       { showroom:{ start:'10:00', end:'20:00' } },
  'Idealz Liberty Plaza': { showroom:{ start:'10:00', end:'19:00' } },
  'Idealz Prime':        { showroom:{ start:'09:45', end:'19:30' }, backoffice:{ start:'09:30', end:'18:30' } },
}
// ── GPS Coordinates for each showroom ────────────────────────────────────────
// Radius is 150m because indoor mall GPS can drift 50-100m
const SHOWROOM_LOCATIONS = {
  'Idealz Marino':       { lat: 6.900183,  lng: 79.852234,  radius: 50 },
  'Idealz Liberty Plaza': { lat: 6.911688,  lng: 79.851517,  radius: 50 },
  'Idealz Prime':        { lat: 6.8912695, lng: 79.8560961, radius: 50 },
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
    return { allowed: true, distance: dist, message: `✅ You are inside ${showroom} (${dist}m away)` }
  }
  return { allowed: false, distance: dist, message: `❌ You are ${dist}m away from ${showroom}. Please move closer to the showroom entrance.` }
}

// Get current GPS position — fast single reading, no cache
function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('GPS not supported on this device'))
      return
    }

    let resolved = false

    // Primary: fresh high-accuracy reading (no cache — maximumAge:0)
    navigator.geolocation.getCurrentPosition(
      pos => {
        if (resolved) return
        resolved = true
        resolve({
          lat:      pos.coords.latitude,
          lng:      pos.coords.longitude,
          accuracy: pos.coords.accuracy
        })
      },
      err => {
        if (resolved) return
        // If high accuracy fails, try low accuracy as fallback
        navigator.geolocation.getCurrentPosition(
          pos => {
            if (resolved) return
            resolved = true
            resolve({
              lat:      pos.coords.latitude,
              lng:      pos.coords.longitude,
              accuracy: pos.coords.accuracy
            })
          },
          err2 => {
            if (!resolved) reject(err2)
          },
          { enableHighAccuracy: false, timeout: 8000, maximumAge: 0 }
        )
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0  // NEVER use cached location — always get fresh GPS
      }
    )

    // Safety timeout — if GPS takes more than 12 seconds, reject
    setTimeout(() => {
      if (!resolved) {
        resolved = true
        reject(new Error('GPS timeout — please try again'))
      }
    }, 12000)
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
  const [returnModal, setReturnM]= useState(false)
  const [returnEmp, setReturnEmp]= useState('')
  const [onLeaveEmps, setOnLeaveEmps] = useState([]) // employees currently on leave
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
  const [empSearch, setEmpSearch]   = useState('')
  const [empFilter, setEmpFilter]   = useState('all')
  const [archiveModal, setArchiveM] = useState(false)
  const [archivePeriod, setArchivePeriod] = useState('1') // months
  const [archiveCount, setArchiveCount] = useState(0)
  const [archiveLoading, setArchiveLoading] = useState(false)

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

    // Find employees currently on leave (left but not returned yet)
    const currentlyOnLeave = []
    const empIds = [...new Set(recs.map(r=>r.empId))]
    empIds.forEach(empId => {
      const empRecs = recs.filter(r=>r.empId===empId).sort((a,b)=>(a.createdAt||0)-(b.createdAt||0))
      const lastRec = empRecs[empRecs.length-1]
      if (lastRec?.type === 'leave') {
        const leaveRec = lastRec
        const now = new Date()
        const [h,m,s] = leaveRec.time.split(':').map(Number)
        const leaveTime = new Date()
        leaveTime.setHours(h,m,s||0,0)
        const minutesGone = Math.round((now - leaveTime) / 60000)
        const expectedDur = leaveRec.duration || 30
        const overdue = minutesGone > expectedDur
        const emp = emps.find(e=>e.empId===empId)
        if (emp) currentlyOnLeave.push({
          ...emp, leaveRec, minutesGone, expectedDur, overdue,
          overdueBy: overdue ? minutesGone - expectedDur : 0
        })
      }
    })
    setOnLeaveEmps(currentlyOnLeave)
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

    // ── Check Firebase directly for duplicate (not local state) ─────────────
    try {
      const dupCheck = await getDocs(query(
        collection(db,'records'),
        where('empId','==',emp.empId),
        where('date','==',today()),
        where('type','==',type)
      ))
      if (!dupCheck.empty) {
        const existingTime = dupCheck.docs[0].data().time
        const label = type === 'arrive' ? 'Arrival' : 'Departure'
        return showToast(`❌ ${emp.name} already recorded ${label} today at ${existingTime}`, 'error')
      }
    } catch(err) {
      // fallback to local check if Firebase query fails
      const alreadyDone = todayRecs.find(r => r.empId === emp.empId && r.type === type)
      if (alreadyDone) {
        const label = type === 'arrive' ? 'Arrival' : 'Departure'
        return showToast(`❌ ${emp.name} already recorded ${label} today at ${alreadyDone.time}`, 'error')
      }
    }

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
      if (e.code === 1) {
        showToast('❌ Location permission denied. Go to browser Settings → Allow Location.','error')
      } else if (e.code === 2) {
        showToast('❌ GPS signal weak. Move to an open area and try again.','error')
      } else if (e.message && e.message.includes('timeout')) {
        showToast('❌ GPS timed out. Make sure Location is ON and try again.','error')
      } else {
        showToast('❌ Could not get location. Check your GPS is turned ON.','error')
      }
      setTimeout(()=>setGpsStatus(''), 4000)
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
      if (e.code === 1) {
        showToast('❌ Location permission denied. Go to Settings → Allow Location.','error')
      } else if (e.message && e.message.includes('timeout')) {
        showToast('❌ GPS timed out. Make sure Location is ON and try again.','error')
      } else {
        showToast('❌ Could not get location. Check your GPS is turned ON.','error')
      }
      setTimeout(()=>setGpsStatus(''),4000)
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

  async function submitReturn() {
    const eid = session?.role==='employee' ? employees[0]?.id : returnEmp
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
      if (e.code === 1) {
        showToast('❌ Location permission denied. Go to Settings → Allow Location.','error')
      } else if (e.message && e.message.includes('timeout')) {
        showToast('❌ GPS timed out. Make sure Location is ON and try again.','error')
      } else {
        showToast('❌ Could not get location. Check your GPS is turned ON.','error')
      }
      setTimeout(()=>setGpsStatus(''),4000)
      return
    }

    setFpLabel(`Return from leave — ${emp.name}`); setFpOv(true)
    const ok = await verifyBiometric(emp.empId)
    setFpOv(false); setGpsStatus('')
    if (!ok) return showToast('Face ID / fingerprint did not match.','error')

    // Find the original leave record to calculate actual duration
    const leaveRec = onLeaveEmps.find(e=>e.id===eid)?.leaveRec
    const actualMinutes = onLeaveEmps.find(e=>e.id===eid)?.minutesGone || 0
    const expectedDur   = leaveRec?.duration || 30
    const overdue       = actualMinutes > expectedDur
    const overdueBy     = overdue ? actualMinutes - expectedDur : 0

    const rec = {
      empId:emp.empId, empName:emp.name, showroom:selRoom,
      type:'return', date:today(), time:nowTime(),
      reason: overdue ? `Returned ${overdueBy} min late (expected ${expectedDur} min, took ${actualMinutes} min)` : `Returned on time (${actualMinutes} min)`,
      duration: actualMinutes,
      expectedDuration: expectedDur,
      overdue, overdueBy,
    }
    await addDoc(collection(db,'records'),{...rec,createdAt:Date.now()})
    setLog(p=>[{...rec,id:Date.now()},...p])
    setTodayRecs(p=>{const n=[...p,rec];computeStats(employees,n);return n})
    setReturnM(false); setReturnEmp('')

    if (overdue) {
      showToast(`⚠️ ${emp.name} returned ${overdueBy} min LATE! (took ${actualMinutes} min, expected ${expectedDur} min)`,'error')
    } else {
      showToast(`✅ ${emp.name} returned on time (${actualMinutes} min)`)
    }
  }

  // ── Archive: count old records ──────────────────────────────────────────────
  async function countOldRecords(months) {
    const cutoff = new Date()
    cutoff.setMonth(cutoff.getMonth() - parseInt(months))
    const cutoffStr = cutoff.toISOString().split('T')[0]
    const snap = await getDocs(collection(db,'records'))
    const old = snap.docs.filter(d => (d.data().date||'') < cutoffStr)
    return { docs: old, cutoffStr }
  }

  async function openArchiveModal() {
    setArchiveLoading(true); setArchiveM(true)
    const { docs } = await countOldRecords(archivePeriod)
    setArchiveCount(docs.length); setArchiveLoading(false)
  }

  async function handleArchivePeriodChange(months) {
    setArchivePeriod(months); setArchiveLoading(true)
    const { docs } = await countOldRecords(months)
    setArchiveCount(docs.length); setArchiveLoading(false)
  }

  async function exportAndDeleteOldRecords() {
    setArchiveLoading(true)
    try {
      const { docs, cutoffStr } = await countOldRecords(archivePeriod)
      if (docs.length === 0) { showToast('No records found for this period.','info'); setArchiveM(false); setArchiveLoading(false); return }

      // Step 1: Export to CSV first
      const rows = [['Employee','Showroom','Type','Time','Date','Reason','Duration(min)','Overdue']]
      docs.forEach(d => {
        const r = d.data()
        rows.push([r.empName||'',r.showroom||'',r.type||'',r.time||'',r.date||'',r.reason||'',r.duration||'',r.overdue?'Yes':'No'])
      })
      const csv = rows.map(r=>r.map(c=>`"${c}"`).join(',')).join('\n')
      const a = document.createElement('a')
      a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv)
      a.download = `idealz-archive-before-${cutoffStr}.csv`
      a.click()

      // Step 2: Delete from Firebase
      await Promise.all(docs.map(d => deleteDoc(doc(db,'records',d.id))))

      showToast(`✅ Exported & deleted ${docs.length} records older than ${archivePeriod} month(s)`)
      setArchiveM(false)
    } catch(e) {
      showToast('Error during archive. Try again.','error')
    }
    setArchiveLoading(false)
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

  const typeLabel={arrive:'Arrive',depart:'Depart',leave:'Short Leave',return:'Returned'}
  const logColors={arrive:'#43e97b',depart:'#ff6584',leave:'#f7c948',return:'#a78bfa'}
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
        <div style={S.brand}>
          <img src="https://raw.githubusercontent.com/shaAhame/showroom-attendance/main/logo.jpeg" alt="iDealz" style={{height:32,objectFit:'contain'}}/>
          <span style={{fontSize:'0.78rem',fontWeight:600,color:'#64748b',borderLeft:'1px solid #e2e8f0',paddingLeft:10,marginLeft:4}}>Attendance</span>
        </div>
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
        <div style={{background:'#e8f1fd',borderBottom:'1px solid #bfdbfe',padding:'8px 24px',fontSize:'0.76rem',color:'#1456b8',textAlign:'center',fontWeight:500}}>
          👋 Welcome, {session.name} · You can check in and out for yourself only
        </div>
      )}
      {session.role === 'manager' && (
        <div style={{background:'#f0f9ff',borderBottom:'1px solid #bae6fd',padding:'8px 24px',fontSize:'0.76rem',color:'#0369a1',textAlign:'center',fontWeight:500}}>
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
            const imgs = ['https://raw.githubusercontent.com/shaAhame/showroom-attendance/main/IMG_0749.jpeg','https://raw.githubusercontent.com/shaAhame/showroom-attendance/main/liberty.jpg','https://raw.githubusercontent.com/shaAhame/showroom-attendance/main/IMG_4420.jpeg']
            return (
              <div key={s} style={{...S.roomCard,...(selRoom===s?S.roomOn:{}),opacity:locked?0.4:1,cursor:locked?'not-allowed':'pointer'}}
                onClick={()=>{ if(!locked){setSelRoom(s)} }}>
                {/* Showroom photo */}
                <div style={{height:90,overflow:'hidden',position:'relative'}}>
                  <img src={imgs[i]} alt={s} style={{width:'100%',height:'100%',objectFit:'cover',transition:'transform .3s'}}/>
                  <div style={{position:'absolute',inset:0,background:selRoom===s?'rgba(26,111,232,0.15)':'rgba(0,0,0,0.08)'}}/>
                  {locked&&<div style={{position:'absolute',top:6,right:6,background:'rgba(0,0,0,0.6)',borderRadius:6,padding:'2px 7px',fontSize:'0.65rem',color:'#fff'}}>🔒</div>}
                  {selRoom===s&&<div style={{position:'absolute',top:6,right:6,background:'#1a6fe8',borderRadius:6,padding:'2px 8px',fontSize:'0.65rem',color:'#fff',fontWeight:600}}>✓ Selected</div>}
                </div>
                {/* Card info */}
                <div style={{padding:'10px 12px'}}>
                  <div style={{fontFamily:"'Inter',sans-serif",fontWeight:700,fontSize:'0.82rem',marginBottom:2,color:selRoom===s?'#1a6fe8':'#0f172a'}}>{s}</div>
                  <div style={{fontSize:'0.68rem',color:'#64748b'}}>{stats.byShowroom?.[s]??0} checked in today</div>
                </div>
              </div>
            )
          })}
        </div>

        {/* On Leave Alert Banner */}
        {onLeaveEmps.filter(e=>!selRoom||e.showroom===selRoom).length>0&&(
          <div style={{marginBottom:16,borderRadius:12,overflow:'hidden',border:'1px solid rgba(247,201,72,0.3)'}}>
            <div style={{padding:'8px 16px',background:'rgba(247,201,72,0.1)',fontSize:'0.76rem',fontWeight:600,color:'var(--gold)',borderBottom:'1px solid rgba(247,201,72,0.2)'}}>
              🕐 Currently on short leave
            </div>
            {onLeaveEmps.filter(e=>!selRoom||e.showroom===selRoom).map(e=>(
              <div key={e.id} style={{display:'flex',alignItems:'center',gap:10,padding:'10px 16px',background:'rgba(10,10,15,0.5)',borderBottom:'1px solid rgba(42,42,61,0.3)'}}>
                <div style={{width:30,height:30,borderRadius:'50%',background:e.color+'22',color:e.color,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:700,fontSize:'0.72rem',flexShrink:0}}>{initials(e.name)}</div>
                <div style={{flex:1}}>
                  <div style={{fontSize:'0.82rem',fontWeight:500}}>{e.name}</div>
                  <div style={{fontSize:'0.7rem',color:'var(--muted)'}}>Left at {e.leaveRec.time} · {e.leaveRec.reason} · Expected {e.expectedDur} min</div>
                </div>
                <div style={{textAlign:'right',flexShrink:0}}>
                  <div style={{fontSize:'0.8rem',fontWeight:700,color:e.overdue?'var(--accent2)':'var(--accent3)'}}>{e.minutesGone} min</div>
                  {e.overdue
                    ? <div style={{fontSize:'0.68rem',color:'var(--accent2)'}}>⚠️ {e.overdueBy} min overdue!</div>
                    : <div style={{fontSize:'0.68rem',color:'var(--accent3)'}}>On time</div>
                  }
                </div>
              </div>
            ))}
          </div>
        )}

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
            <button className="fp-btn" style={{...S.btn,background:'linear-gradient(135deg,#f7c948,#ff9a4a)',color:'#0a0a0f',marginBottom:10,opacity:selRoom?1:0.5}}
              onClick={()=>{ if(!selRoom) return showToast('Select a showroom first.','error'); setLeaveM(true) }}>
              🕐 Short Leave
            </button>
            {/* Return from Leave — only show if someone is currently on leave */}
            {onLeaveEmps.length>0 && (session.role==='employee'
              ? onLeaveEmps.find(e=>e.empId===session.empId)
              : true) && (
              <button className="fp-btn" style={{...S.btn,background:'linear-gradient(135deg,#6c63ff,#a78bfa)',color:'#fff',opacity:selRoom?1:0.5}}
                onClick={()=>{ if(!selRoom) return showToast('Select a showroom first.','error'); setReturnM(true) }}>
                🔙 Return from Leave
              </button>
            )}
          </div>

          <div className="card-pad" style={S.card}>
            <h3 style={S.cardH}>Today's Log</h3>
            <div style={S.logBox}>
              {log.length===0
                ? <div style={{color:'var(--muted)',fontSize:'0.78rem',textAlign:'center',padding:'20px 0'}}>No activity yet</div>
                : log.map(r=>(
                  <div key={r.id} style={S.logRow}>
                    <div style={{width:6,height:6,borderRadius:'50%',background:logColors[r.type]||'#fff',flexShrink:0,marginTop:5}}/>
                    <span style={{color:'#94a3b8',fontSize:'0.7rem',whiteSpace:'nowrap'}}>{r.time}</span>
                    <span style={{fontSize:'0.74rem',overflow:'hidden',textOverflow:'ellipsis',color:'#374151'}}>{r.empName.split(' ')[0]} · {typeLabel[r.type]}{r.duration?` (${r.duration}m)`:''}</span>
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
                      <td style={{padding:'9px 10px'}}>
                        <span style={badge(r.type,r.overdue)}>{typeLabel[r.type]||r.type}</span>
                        {r.type==='return'&&r.overdue&&<span style={{marginLeft:4,fontSize:'0.65rem',color:'#ff6584'}}>⚠️ +{r.overdueBy}m</span>}
                      </td>
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
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:12}}>
              <h3 style={{...S.cardH,marginBottom:0}}>👥 Employees ({employees.filter(e=>{
                const ms=!empSearch||e.name.toLowerCase().includes(empSearch.toLowerCase())||e.empId.toLowerCase().includes(empSearch.toLowerCase())
                const mf=empFilter==='all'||e.showroom===empFilter
                return ms&&mf
              }).length} / {employees.length})</h3>
            </div>
            <input
              placeholder="🔍 Search name or ID..."
              value={empSearch}
              onChange={e=>setEmpSearch(e.target.value)}
              style={{width:'100%',padding:'9px 12px',background:'#f8fafc',border:'1.5px solid #e2e8f0',borderRadius:8,fontSize:'14px',marginBottom:10,outline:'none',fontFamily:"'Inter',sans-serif",color:'#0f172a'}}
            />
            <div style={{display:'flex',gap:6,marginBottom:10,flexWrap:'wrap'}}>
              {['All',...SHOWROOMS.map(s=>s.replace('Idealz ',''))].map((f,i)=>(
                <button key={f} onClick={()=>setEmpFilter(i===0?'all':SHOWROOMS[i-1])}
                  style={{padding:'4px 12px',borderRadius:20,border:'1px solid',fontSize:'0.72rem',cursor:'pointer',fontFamily:"'Inter',sans-serif",fontWeight:500,
                    borderColor:empFilter===(i===0?'all':SHOWROOMS[i-1])?'#1a6fe8':'#e2e8f0',
                    background:empFilter===(i===0?'all':SHOWROOMS[i-1])?'#e8f1fd':'#fff',
                    color:empFilter===(i===0?'all':SHOWROOMS[i-1])?'#1a6fe8':'#64748b',
                  }}>
                  {f}
                </button>
              ))}
            </div>
            <div style={{display:'flex',flexDirection:'column',gap:8}}>
              {employees.filter(e=>{
                const matchSearch = !empSearch || e.name.toLowerCase().includes(empSearch.toLowerCase()) || e.empId.toLowerCase().includes(empSearch.toLowerCase())
                const matchFilter = empFilter==='all' || e.showroom===empFilter
                return matchSearch && matchFilter
              }).map(e=>{
                const recs=todayRecs.filter(r=>r.empId===e.empId)
                const last=[...recs].sort((a,b)=>(b.createdAt||0)-(a.createdAt||0))[0]
                const sm={arrive:['Present','#43e97b'],depart:['Departed','#ff6584'],leave:['On Leave','#f7c948'],return:['Returned','#6c63ff']}
                const [lbl,clr]=(last&&sm[last.type])||['Not in','#6b6b8a']
                const shift=getShift(e.showroom,e.staffType)
                const isEditing = editPinId===e.id
                return (
                  <div key={e.id} style={{background:'#fff',borderRadius:12,border:'1px solid #e2e8f0',boxShadow:'0 1px 3px rgba(0,0,0,0.04)'}}>
                    {/* Top row: avatar + info + status */}
                    <div style={{display:'flex',alignItems:'center',gap:10,padding:'12px 14px'}}>
                      <div style={{width:38,height:38,borderRadius:'50%',background:e.color+'22',color:e.color,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:700,fontSize:'0.82rem',flexShrink:0}}>{initials(e.name)}</div>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:'0.85rem',fontWeight:600,color:'#0f172a',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{e.name}</div>
                        <div style={{fontSize:'0.7rem',color:'#64748b'}}>{e.empId} · {e.showroom.replace('Idealz ','')} · <span style={{color:roleColor[e.role]||'#64748b',fontWeight:500}}>{ROLE_LABELS[e.role]||e.role}</span></div>
                      </div>
                      <span style={{fontSize:'0.68rem',color:clr,background:clr+'22',padding:'3px 8px',borderRadius:20,whiteSpace:'nowrap',flexShrink:0,fontWeight:500}}>{lbl}</span>
                    </div>
                    {/* Action buttons — always visible */}
                    <div style={{display:'flex',flexDirection:'row',borderTop:'1px solid #f1f5f9',width:'100%'}}>
                      <button
                        onClick={()=>{ setEditPinId(isEditing?null:e.id); setEditPinVal('') }}
                        style={{flex:1,padding:'10px 8px',background:isEditing?'#fef3c7':'#f8fafc',border:'none',borderRight:'1px solid #e2e8f0',color:isEditing?'#92400e':'#1456b8',fontSize:'0.78rem',cursor:'pointer',fontWeight:600,fontFamily:"'Inter',sans-serif",textAlign:'center'}}>
                        🔑 {isEditing?'Cancel':'Change PIN'}
                      </button>
                      <button
                        onClick={()=>{ if(window.confirm('Delete '+e.name+'? This cannot be undone.')) removeEmployee(e.id,e.name) }}
                        style={{flex:1,padding:'10px 8px',background:'#fff5f5',border:'none',color:'#dc2626',fontSize:'0.78rem',cursor:'pointer',fontWeight:600,fontFamily:"'Inter',sans-serif",textAlign:'center'}}>
                        🗑️ Delete
                      </button>
                    </div>
                    {/* PIN edit - shows when Change PIN clicked */}
                    {isEditing && (
                      <div style={{padding:'10px 14px',background:'#fffbeb',borderTop:'1px solid #fde68a',display:'flex',gap:8,alignItems:'center'}}>
                        <input
                          type="password"
                          inputMode="numeric"
                          placeholder="New PIN (4–6 digits)"
                          value={editPinVal}
                          onChange={e=>setEditPinVal(e.target.value.replace(/\D/g,'').slice(0,6))}
                          maxLength={6}
                          style={{flex:1,padding:'8px 12px',background:'#fff',border:'1.5px solid #fde68a',borderRadius:8,color:'#0f172a',fontFamily:"'Inter',sans-serif",fontSize:'14px',outline:'none'}}
                        />
                        <button onClick={()=>savePinEdit(e.id)}
                          style={{padding:'8px 16px',background:'#1a6fe8',border:'none',borderRadius:8,color:'#fff',fontSize:'0.78rem',cursor:'pointer',fontWeight:700,fontFamily:"'Inter',sans-serif",whiteSpace:'nowrap'}}>
                          ✓ Save
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

            {/* Archive Section */}
            <div style={{marginTop:20,padding:16,background:'rgba(255,101,132,0.05)',border:'1px solid rgba(255,101,132,0.2)',borderRadius:12}}>
              <h3 style={{fontFamily:'var(--font-head)',fontSize:'0.95rem',marginBottom:8,color:'var(--accent2)'}}>🗂️ Archive Old Records</h3>
              <div style={{fontSize:'0.72rem',color:'var(--muted)',marginBottom:12,lineHeight:1.5}}>
                Export attendance records to CSV then permanently delete them from the database. Use this to keep the database clean.
              </div>
              <button
                style={{width:'100%',padding:'10px',background:'rgba(255,101,132,0.1)',border:'1px solid rgba(255,101,132,0.3)',borderRadius:8,color:'var(--accent2)',fontSize:'0.8rem',cursor:'pointer',fontFamily:'var(--font-head)',fontWeight:700}}
                onClick={openArchiveModal}>
                📦 Export & Delete Old Records
              </button>
            </div>
          </div>
        </div>
      </div>}

      {/* FP/Bio overlay */}
      {fpOverlay&&(
        <div style={S.fpOv}>
          <div style={S.fpCircle}>👤</div>
          <div style={{fontFamily:"'Inter',sans-serif",fontSize:'1.1rem',fontWeight:700,textAlign:'center',padding:'0 20px',color:'#fff'}}>{fpLabel}</div>
          <div style={{fontSize:'0.78rem',color:'rgba(255,255,255,0.7)'}}>Use Face ID or fingerprint sensor</div>
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

      {/* Return from Leave Modal */}
      {returnModal&&(
        <div style={S.modalBg} onClick={e=>e.target===e.currentTarget&&setReturnM(false)}>
          <div className="modal-box" style={S.modal}>
            <h3 style={{fontFamily:'var(--font-head)',fontSize:'1.1rem',marginBottom:6}}>🔙 Return from Leave</h3>
            <div style={{fontSize:'0.74rem',color:'var(--muted)',marginBottom:16}}>Confirm you are back at the showroom</div>

            {/* Show who is on leave */}
            {onLeaveEmps.filter(e=>!selRoom||e.showroom===selRoom).length>0 && (
              <div style={{marginBottom:16,borderRadius:10,overflow:'hidden',border:'1px solid var(--border)'}}>
                {onLeaveEmps.filter(e=>!selRoom||e.showroom===selRoom).map(e=>(
                  <div key={e.id} style={{display:'flex',alignItems:'center',gap:10,padding:'10px 12px',background:e.overdue?'rgba(255,101,132,0.05)':'var(--surface)',borderBottom:'1px solid var(--border)'}}>
                    <div style={{width:30,height:30,borderRadius:'50%',background:e.color+'22',color:e.color,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:700,fontSize:'0.72rem',flexShrink:0}}>{initials(e.name)}</div>
                    <div style={{flex:1}}>
                      <div style={{fontSize:'0.8rem',fontWeight:500}}>{e.name}</div>
                      <div style={{fontSize:'0.68rem',color:'var(--muted)'}}>Out for {e.minutesGone} min · Expected {e.expectedDur} min</div>
                    </div>
                    {e.overdue&&<span style={{fontSize:'0.68rem',color:'var(--accent2)',background:'rgba(255,101,132,0.1)',padding:'2px 8px',borderRadius:20,flexShrink:0}}>⚠️ {e.overdueBy}m late</span>}
                  </div>
                ))}
              </div>
            )}

            {session.role!=='employee'&&(
              <div style={{marginBottom:12}}>
                <div style={S.inputLabel}>Select Employee</div>
                <select value={returnEmp} onChange={e=>setReturnEmp(e.target.value)} style={S.adminInput}>
                  <option value="">— Select —</option>
                  {onLeaveEmps.filter(e=>!selRoom||e.showroom===selRoom).map(e=>(
                    <option key={e.id} value={e.id}>{e.name} {e.overdue?`(⚠️ ${e.overdueBy}m overdue)`:''}</option>
                  ))}
                </select>
              </div>
            )}

            <div style={{padding:'10px 14px',background:'rgba(108,99,255,0.08)',borderRadius:8,fontSize:'0.76rem',color:'var(--accent)',marginBottom:16}}>
              👤 Face ID will verify your identity when you return
            </div>

            <div style={{display:'flex',gap:10}}>
              <button style={{padding:'12px 16px',background:'transparent',color:'var(--muted)',border:'1px solid var(--border)',borderRadius:8,cursor:'pointer',fontFamily:'var(--font-mono)'}} onClick={()=>setReturnM(false)}>Cancel</button>
              <button style={{...S.btn,flex:1,background:'linear-gradient(135deg,#6c63ff,#a78bfa)',color:'#fff',padding:12}} onClick={submitReturn}>👤 Face ID — I'm Back</button>
            </div>
          </div>
        </div>
      )}

      {/* Archive Modal */}
      {archiveModal&&(
        <div style={S.modalBg} onClick={e=>e.target===e.currentTarget&&setArchiveM(false)}>
          <div className="modal-box" style={S.modal}>
            <h3 style={{fontFamily:'var(--font-head)',fontSize:'1.1rem',marginBottom:6,color:'var(--accent2)'}}>🗂️ Export & Delete Old Records</h3>
            <div style={{fontSize:'0.74rem',color:'var(--muted)',marginBottom:20,lineHeight:1.6}}>
              This will <strong style={{color:'var(--text)'}}>first download a CSV backup</strong>, then permanently delete the selected records from Firebase. This cannot be undone.
            </div>

            <div style={{marginBottom:16}}>
              <div style={S.inputLabel}>Delete records older than</div>
              <select
                value={archivePeriod}
                onChange={e=>handleArchivePeriodChange(e.target.value)}
                style={S.adminInput}>
                <option value="1">1 month</option>
                <option value="2">2 months</option>
                <option value="3">3 months</option>
                <option value="6">6 months</option>
                <option value="12">1 year</option>
              </select>
            </div>

            {/* Record count preview */}
            <div style={{padding:'14px 16px',background:'var(--surface)',borderRadius:10,border:'1px solid var(--border)',marginBottom:20,textAlign:'center'}}>
              {archiveLoading
                ? <div style={{fontSize:'0.82rem',color:'var(--muted)'}}>Counting records…</div>
                : archiveCount===0
                  ? <div style={{fontSize:'0.82rem',color:'var(--accent3)'}}>✅ No records found older than {archivePeriod} month(s)</div>
                  : <>
                    <div style={{fontFamily:'var(--font-head)',fontSize:'2rem',fontWeight:800,color:'var(--accent2)'}}>{archiveCount}</div>
                    <div style={{fontSize:'0.76rem',color:'var(--muted)',marginTop:4}}>records will be exported & deleted</div>
                  </>
              }
            </div>

            {/* Warning */}
            {archiveCount>0&&(
              <div style={{padding:'10px 14px',background:'rgba(255,101,132,0.08)',border:'1px solid rgba(255,101,132,0.2)',borderRadius:8,fontSize:'0.74rem',color:'var(--accent2)',marginBottom:16,lineHeight:1.5}}>
                ⚠️ A CSV file will download automatically first. Make sure to save it before confirming deletion.
              </div>
            )}

            <div style={{display:'flex',gap:10}}>
              <button
                style={{padding:'12px 16px',background:'transparent',color:'var(--muted)',border:'1px solid var(--border)',borderRadius:8,cursor:'pointer',fontFamily:'var(--font-mono)'}}
                onClick={()=>setArchiveM(false)}>
                Cancel
              </button>
              <button
                style={{...S.btn,flex:1,background:archiveCount>0?'var(--accent2)':'var(--border)',color:'#fff',padding:12,opacity:archiveLoading||archiveCount===0?0.5:1}}
                onClick={exportAndDeleteOldRecords}
                disabled={archiveLoading||archiveCount===0}>
                {archiveLoading?'Processing…':`⬇ Export & Delete ${archiveCount} Records`}
              </button>
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
          <button className="bnav-btn" onClick={logout} style={{color:'#ef4444'}}><span className="bnav-icon">🚪</span><span>Sign out</span></button>
        </div>
      </div>
    </div>
  </>)
}

function badge(type, overdue=false){
  if(type==='return'&&overdue) return {display:'inline-block',padding:'3px 10px',borderRadius:20,fontSize:'0.72rem',fontWeight:500,background:'#fee2e2',color:'#dc2626',whiteSpace:'nowrap'}
  const m={arrive:['#dcfce7','#16a34a'],depart:['#fee2e2','#dc2626'],leave:['#fef3c7','#d97706'],return:['#ede9fe','#7c3aed']}
  const [bg,color]=m[type]||['#f1f5f9','#64748b']
  return {display:'inline-block',padding:'3px 10px',borderRadius:20,fontSize:'0.72rem',fontWeight:500,background:bg,color,whiteSpace:'nowrap'}
}

const S={
  nav:{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'0 24px',height:64,borderBottom:'1px solid #e2e8f0',background:'#fff',position:'sticky',top:0,zIndex:100,fontFamily:"'Inter',sans-serif",gap:12,boxShadow:'0 1px 8px rgba(0,0,0,0.06)'},
  brand:{fontFamily:"'Inter',sans-serif",fontSize:'1rem',fontWeight:800,display:'flex',alignItems:'center',gap:10,flexShrink:0},
  dot:{width:8,height:8,borderRadius:'50%',background:'#1a6fe8'},
  tabs:{display:'flex',gap:4,background:'#f1f5f9',padding:3,borderRadius:10,border:'1px solid #e2e8f0'},
  tab:{padding:'6px 14px',borderRadius:7,fontFamily:"'Inter',sans-serif",fontSize:'0.76rem',fontWeight:500,cursor:'pointer',border:'none',background:'transparent',color:'#64748b'},
  tabOn:{background:'#1a6fe8',color:'#fff',boxShadow:'0 2px 8px rgba(26,111,232,0.3)'},
  page:{position:'relative',zIndex:1,padding:'24px 24px 100px',maxWidth:1100,margin:'0 auto'},
  h1:{fontFamily:"'Inter',sans-serif",fontSize:'1.5rem',fontWeight:800,marginBottom:6,color:'#0f172a'},
  sub:{fontSize:'0.78rem',color:'#64748b',marginBottom:24},
  roomGrid:{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:14,marginBottom:24},
  roomCard:{background:'#fff',border:'2px solid #e2e8f0',borderRadius:16,overflow:'hidden',cursor:'pointer',transition:'all .2s',boxShadow:'0 1px 4px rgba(0,0,0,0.04)'},
  roomOn:{borderColor:'#1a6fe8',boxShadow:'0 4px 20px rgba(26,111,232,0.2)'},
  grid2:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16},
  card:{background:'#fff',border:'1px solid #e2e8f0',borderRadius:16,padding:22,boxShadow:'0 1px 4px rgba(0,0,0,0.04)'},
  cardH:{fontFamily:"'Inter',sans-serif",fontSize:'1rem',fontWeight:700,marginBottom:16,color:'#0f172a'},
  sel:{width:'100%',padding:'11px 14px',background:'#fff',border:'1.5px solid #e2e8f0',borderRadius:10,color:'#0f172a',fontFamily:"'Inter',sans-serif",fontSize:'16px',marginBottom:12,cursor:'pointer',outline:'none'},
  btn:{width:'100%',padding:14,borderRadius:12,border:'none',fontFamily:"'Inter',sans-serif",fontWeight:700,fontSize:'0.95rem',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:8,transition:'all .2s'},
  logBox:{background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:10,padding:12,maxHeight:200,overflowY:'auto'},
  logRow:{display:'flex',alignItems:'flex-start',gap:8,padding:'6px 0',borderBottom:'1px solid #f1f5f9',fontSize:'0.75rem'},
  filters:{display:'flex',gap:10,marginBottom:20,flexWrap:'wrap',alignItems:'center'},
  exportBtn:{padding:'10px 16px',background:'#1a6fe8',color:'#fff',border:'none',borderRadius:8,fontFamily:"'Inter',sans-serif",fontWeight:600,cursor:'pointer',fontSize:'0.82rem',whiteSpace:'nowrap'},
  statsGrid:{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginBottom:20},
  statCard:{background:'#fff',border:'1px solid #e2e8f0',borderRadius:12,padding:16,boxShadow:'0 1px 4px rgba(0,0,0,0.04)'},
  fpOv:{position:'fixed',inset:0,background:'rgba(15,23,42,0.85)',zIndex:300,display:'flex',alignItems:'center',justifyContent:'center',flexDirection:'column',gap:20,backdropFilter:'blur(4px)'},
  fpCircle:{width:110,height:110,borderRadius:'50%',border:'3px solid #1a6fe8',display:'flex',alignItems:'center',justifyContent:'center',fontSize:'3rem',background:'#e8f1fd'},
  modalBg:{position:'fixed',inset:0,background:'rgba(15,23,42,0.6)',backdropFilter:'blur(4px)',zIndex:200,display:'flex',alignItems:'center',justifyContent:'center',padding:16},
  modal:{background:'#fff',border:'1px solid #e2e8f0',borderRadius:20,padding:24,width:420,maxWidth:'100%',boxShadow:'0 20px 60px rgba(0,0,0,0.15)'},
  toast:{position:'fixed',bottom:80,right:16,zIndex:999,background:'#fff',border:'1px solid',borderRadius:12,padding:'12px 18px',fontSize:'0.82rem',maxWidth:'calc(100vw - 32px)',fontFamily:"'Inter',sans-serif",boxShadow:'0 4px 20px rgba(0,0,0,0.12)'},
  warnBox:{fontSize:'0.78rem',color:'#d97706',marginBottom:12,padding:'8px 12px',background:'#fef3c7',borderRadius:8,border:'1px solid #fde68a'},
  inputLabel:{fontSize:'0.75rem',fontWeight:600,color:'#374151',marginBottom:5},
  adminInput:{background:'#fff',border:'1.5px solid #e2e8f0',borderRadius:10,color:'#0f172a',fontFamily:"'Inter',sans-serif",fontSize:'16px',padding:'11px 14px',width:'100%',outline:'none'},
}
