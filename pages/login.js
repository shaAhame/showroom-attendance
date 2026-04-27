import { useState, useEffect, useRef } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import { db } from '../lib/firebase'
import { collection, getDocs, query, where } from 'firebase/firestore'
import { saveSession, getSession } from '../lib/auth'

// ── WebAuthn / Face ID ────────────────────────────────────────────────────────
async function verifyBiometric(empId) {
  if (!window.PublicKeyCredential) return true // fallback: skip if not supported
  const challenge = new Uint8Array(32)
  crypto.getRandomValues(challenge)
  const storageKey = `idealz_cred_${empId}`

  try {
    const existing = localStorage.getItem(storageKey)

    if (existing) {
      // Try to authenticate with stored credential
      const credId = Uint8Array.from(atob(existing), c => c.charCodeAt(0))
      await navigator.credentials.get({
        publicKey: {
          challenge,
          timeout: 30000,
          userVerification: 'required', // forces Face ID / fingerprint
          rpId: location.hostname,
          allowCredentials: [{ type: 'public-key', id: credId }],
        }
      })
    } else {
      // First time: register this employee's biometric on this device
      const cred = await navigator.credentials.create({
        publicKey: {
          challenge,
          rp: { name: 'Idealz Attendance', id: location.hostname },
          user: {
            id: new TextEncoder().encode(empId),
            name: empId,
            displayName: empId,
          },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          timeout: 30000,
          authenticatorSelection: {
            authenticatorAttachment: 'platform', // use device Face ID / fingerprint
            userVerification: 'required',
            residentKey: 'preferred',
          },
        }
      })
      // Store credential ID for future logins
      const credIdB64 = btoa(String.fromCharCode(...new Uint8Array(cred.rawId)))
      localStorage.setItem(storageKey, credIdB64)
    }
    return true
  } catch (e) {
    if (e.name === 'NotAllowedError') return false // user cancelled / face didn't match
    // Device doesn't support or no biometric enrolled — allow PIN-only as fallback
    console.warn('Biometric not available, using PIN only:', e.message)
    return true
  }
}

export default function Login() {
  const router  = useRouter()
  const [mounted, setMounted] = useState(false)
  const [step, setStep]       = useState('id')   // 'id' | 'pin' | 'bio'
  const [empId, setEmpId]     = useState('')
  const [employee, setEmp]    = useState(null)
  const [pin, setPin]         = useState(['','','','','',''])
  const [error, setError]     = useState('')
  const [loading, setLoading] = useState(false)
  const [shake, setShake]     = useState(false)
  const [bioStatus, setBioStatus] = useState('') // 'scanning' | 'success' | 'fail'
  const idRef    = useRef()
  const pinRefs  = Array.from({length:6}, ()=>useRef())

  useEffect(() => {
    setMounted(true)
    if (getSession()) router.replace('/')
  }, [])

  useEffect(() => {
    if (step === 'id')  setTimeout(()=>idRef.current?.focus(), 100)
    if (step === 'pin') setTimeout(()=>pinRefs[0].current?.focus(), 100)
  }, [step])

  // ── Step 1: Employee ID ───────────────────────────────────────────────────
  async function handleIdSubmit(e) {
    e?.preventDefault()
    const id = empId.trim().toUpperCase()
    if (!id) return setError('Please enter your Employee ID')
    setLoading(true); setError('')
    try {
      const snap = await getDocs(query(collection(db,'employees'), where('empId','==',id)))
      if (snap.empty) { setError('Employee ID not found.'); setLoading(false); return }
      const emp = { id: snap.docs[0].id, ...snap.docs[0].data() }
      if (!emp.pin) { setError('No PIN set for this account. Ask your Admin.'); setLoading(false); return }
      setEmp(emp); setStep('pin')
    } catch { setError('Connection error. Check your internet.') }
    setLoading(false)
  }

  // ── Step 2: PIN ───────────────────────────────────────────────────────────
  function handlePinDigit(val, i) {
    if (!/^\d*$/.test(val)) return
    const p = [...pin]; p[i] = val.slice(-1); setPin(p); setError('')
    if (val && i < 5) pinRefs[i+1].current?.focus()
    if (val && i === 5) checkPin([...p.slice(0,5), val.slice(-1)].join(''))
  }
  function handlePinKey(e, i) {
    if (e.key==='Backspace' && !pin[i] && i>0) { pinRefs[i-1].current?.focus() }
    if (e.key==='Enter') checkPin(pin.join(''))
  }
  async function checkPin(entered) {
    const full = entered || pin.join('')
    if (full.length < 4) return
    if (full === employee.pin) {
      setStep('bio')
      await runBiometric()
    } else {
      setShake(true); setPin(['','','','','','']); setError('Wrong PIN. Try again.')
      setTimeout(()=>{ setShake(false); pinRefs[0].current?.focus() }, 500)
    }
  }

  // ── Step 3: Face ID / Fingerprint ─────────────────────────────────────────
  async function runBiometric() {
    setBioStatus('scanning')
    const ok = await verifyBiometric(employee.empId)
    if (ok) {
      setBioStatus('success')
      setTimeout(() => {
        saveSession(employee)
        router.replace('/')
      }, 800)
    } else {
      setBioStatus('fail')
      setError('Face ID / fingerprint did not match. Try again.')
      setTimeout(() => { setStep('pin'); setPin(['','','','','','']); setBioStatus('') }, 1500)
    }
  }

  const filled = pin.filter(p=>p!=='').length

  if (!mounted) return null

  return (<>
    <Head>
      <title>Idealz Attendance</title>
      <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/>
      <meta name="theme-color" content="#0a0a0f"/>
      <meta name="apple-mobile-web-app-capable" content="yes"/>
    </Head>

    <div style={S.bg}>
      <div style={S.gridBg}/>

      <div style={S.container}>
        {/* Logo */}
        <div style={S.logo}>
          <div style={S.logoDot}/>
          <span style={S.logoText}>IDEALZ · ATTEND</span>
        </div>

        <div style={S.card}>

          {/* ── STEP 1: Employee ID ── */}
          {step==='id' && <>
            <div style={S.cardIcon}>🏢</div>
            <div style={S.cardTitle}>Welcome</div>
            <div style={S.cardSub}>Enter your Employee ID to sign in</div>
            <form onSubmit={handleIdSubmit}>
              <input
                ref={idRef}
                value={empId}
                onChange={e=>{ setEmpId(e.target.value.toUpperCase()); setError('') }}
                placeholder="e.g. EMP-001"
                style={S.textInput}
                autoCapitalize="characters"
                autoComplete="off"
                autoCorrect="off"
              />
              {error && <div style={S.errBox}>{error}</div>}
              <button type="submit" style={{...S.mainBtn, opacity:loading?0.6:1}} disabled={loading}>
                {loading ? 'Checking…' : 'Continue →'}
              </button>
            </form>
          </>}

          {/* ── STEP 2: PIN ── */}
          {step==='pin' && <>
            {/* Employee info */}
            <div style={S.empChip}>
              <div style={{...S.empAvatar, background:employee?.color+'33', color:employee?.color}}>
                {employee?.name?.split(' ').map(w=>w[0]).join('').slice(0,2)}
              </div>
              <div>
                <div style={S.empName}>{employee?.name}</div>
                <div style={S.empSub}>{employee?.showroom?.replace('Idealz ','')} · {employee?.staffType==='backoffice'?'Back Office':'Showroom'}</div>
              </div>
            </div>

            <div style={S.cardTitle}>Enter your PIN</div>
            <div style={S.cardSub}>6-digit secret PIN</div>

            <div style={{...S.pinRow, animation:shake?'shake .4s ease':'none'}}>
              {pin.map((p,i)=>(
                <input
                  key={i}
                  ref={pinRefs[i]}
                  type="password"
                  inputMode="numeric"
                  maxLength={1}
                  value={p}
                  onChange={e=>handlePinDigit(e.target.value,i)}
                  onKeyDown={e=>handlePinKey(e,i)}
                  style={{
                    ...S.pinBox,
                    borderColor: p ? '#6c63ff' : '#2a2a3d',
                    background:  p ? 'rgba(108,99,255,0.15)' : '#12121a',
                    boxShadow:   p ? '0 0 12px rgba(108,99,255,0.3)' : 'none',
                  }}
                />
              ))}
            </div>

            {error && <div style={S.errBox}>{error}</div>}

            <button
              style={{...S.mainBtn, opacity:filled>=4?1:0.4}}
              onClick={()=>checkPin()}
              disabled={filled<4||loading}
            >
              {loading ? 'Verifying…' : '🔐 Verify PIN'}
            </button>

            <button style={S.backBtn} onClick={()=>{ setStep('id'); setPin(['','','','','','']); setError('') }}>
              ← Different account
            </button>
          </>}

          {/* ── STEP 3: Biometric ── */}
          {step==='bio' && <>
            <div style={{textAlign:'center', padding:'8px 0'}}>
              <div style={{
                ...S.bioCircle,
                borderColor: bioStatus==='success'?'#43e97b': bioStatus==='fail'?'#ff6584':'#6c63ff',
                boxShadow: `0 0 40px ${bioStatus==='success'?'rgba(67,233,123,0.5)':bioStatus==='fail'?'rgba(255,101,132,0.5)':'rgba(108,99,255,0.5)'}`,
                animation: bioStatus==='scanning'?'pulse 1.5s infinite':'none',
              }}>
                {bioStatus==='success' ? '✅' : bioStatus==='fail' ? '❌' : '👤'}
              </div>
              <div style={S.cardTitle}>
                {bioStatus==='scanning' ? 'Scan Face ID / Fingerprint' : bioStatus==='success' ? 'Verified!' : 'Not matched'}
              </div>
              <div style={S.cardSub}>
                {bioStatus==='scanning' ? 'Look at your camera or place finger on sensor' : bioStatus==='success' ? 'Logging you in…' : 'Biometric did not match'}
              </div>
              {bioStatus==='fail' && <div style={S.errBox}>Going back to PIN…</div>}
              {bioStatus==='scanning' && (
                <button style={{...S.backBtn, marginTop:16}} onClick={()=>{ setStep('pin'); setPin(['','','','','','']); setBioStatus('') }}>
                  Cancel
                </button>
              )}
            </div>
          </>}

        </div>

        <div style={S.footer}>
          Idealz Attendance System · Secured with PIN + Biometrics
        </div>
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Mono:wght@400;500&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
        body{background:#0a0a0f;font-family:'DM Mono',monospace}
        @keyframes shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-8px)}40%{transform:translateX(8px)}60%{transform:translateX(-5px)}80%{transform:translateX(5px)}}
        @keyframes fadeUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
        @keyframes pulse{0%,100%{box-shadow:0 0 20px rgba(108,99,255,0.4)}50%{box-shadow:0 0 60px rgba(108,99,255,0.8)}}
      `}</style>
    </div>
  </>)
}

const S = {
  bg:        { minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', background:'#0a0a0f', padding:20, position:'relative', overflow:'hidden' },
  gridBg:    { position:'fixed', inset:0, backgroundImage:'linear-gradient(rgba(108,99,255,0.05) 1px,transparent 1px),linear-gradient(90deg,rgba(108,99,255,0.05) 1px,transparent 1px)', backgroundSize:'40px 40px', pointerEvents:'none' },
  container: { width:'100%', maxWidth:420, position:'relative', zIndex:1, animation:'fadeUp .4s ease' },
  logo:      { display:'flex', alignItems:'center', justifyContent:'center', gap:10, marginBottom:28 },
  logoDot:   { width:10, height:10, borderRadius:'50%', background:'#6c63ff', boxShadow:'0 0 16px #6c63ff' },
  logoText:  { fontFamily:"'Syne',sans-serif", fontWeight:800, fontSize:'1.05rem', letterSpacing:'-0.02em', color:'#e8e8f0' },
  card:      { background:'#1a1a26', border:'1px solid #2a2a3d', borderRadius:22, padding:32, marginBottom:16 },
  cardIcon:  { fontSize:'2.5rem', textAlign:'center', marginBottom:12 },
  cardTitle: { fontFamily:"'Syne',sans-serif", fontSize:'1.35rem', fontWeight:800, color:'#e8e8f0', marginBottom:6, textAlign:'center' },
  cardSub:   { fontSize:'0.76rem', color:'#6b6b8a', marginBottom:24, textAlign:'center' },
  textInput: { width:'100%', padding:'14px 16px', background:'#12121a', border:'1px solid #2a2a3d', borderRadius:12, color:'#e8e8f0', fontFamily:"'DM Mono',monospace", fontSize:'16px', outline:'none', marginBottom:14, letterSpacing:'0.05em' },
  errBox:    { background:'rgba(255,101,132,0.1)', border:'1px solid rgba(255,101,132,0.3)', borderRadius:8, padding:'8px 12px', fontSize:'0.76rem', color:'#ff6584', marginBottom:14, textAlign:'center' },
  mainBtn:   { width:'100%', padding:15, background:'#6c63ff', color:'#fff', border:'none', borderRadius:12, fontFamily:"'Syne',sans-serif", fontWeight:700, fontSize:'1rem', cursor:'pointer', transition:'all .2s', letterSpacing:'-0.01em' },
  backBtn:   { width:'100%', padding:'10px', background:'transparent', color:'#6b6b8a', border:'none', fontFamily:"'DM Mono',monospace", fontSize:'0.78rem', cursor:'pointer', marginTop:12, textAlign:'center' },
  empChip:   { display:'flex', alignItems:'center', gap:12, padding:'12px 14px', background:'#12121a', border:'1px solid #2a2a3d', borderRadius:12, marginBottom:22 },
  empAvatar: { width:42, height:42, borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center', fontWeight:700, fontSize:'0.85rem', flexShrink:0 },
  empName:   { fontSize:'0.9rem', fontWeight:500, color:'#e8e8f0' },
  empSub:    { fontSize:'0.7rem', color:'#6b6b8a', marginTop:2 },
  pinRow:    { display:'flex', gap:8, justifyContent:'center', marginBottom:20 },
  pinBox:    { width:44, height:54, borderRadius:10, border:'1px solid', textAlign:'center', fontSize:'1.4rem', color:'#e8e8f0', fontFamily:"'DM Mono',monospace", outline:'none', transition:'all .15s', cursor:'text' },
  bioCircle: { width:110, height:110, borderRadius:'50%', border:'3px solid', display:'flex', alignItems:'center', justifyContent:'center', fontSize:'2.8rem', margin:'0 auto 20px', transition:'all .3s' },
  footer:    { textAlign:'center', fontSize:'0.68rem', color:'#2a2a3d' },
}
