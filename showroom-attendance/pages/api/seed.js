import { db } from '../../lib/firebase'
import { collection, addDoc, getDocs } from 'firebase/firestore'

// staffType: 'showroom' | 'backoffice'
// Back office staff only exist at Idealz Prime
const SEED_EMPLOYEES = [
  // Idealz Marino — Showroom Staff (10:00 – 20:00)
  { empId: 'EMP-001', name: 'Ahmed Al-Rashid',   showroom: 'Idealz Marino',       staffType: 'showroom',   color: '#6c63ff' },
  { empId: 'EMP-002', name: 'Sara Mohammed',     showroom: 'Idealz Marino',       staffType: 'showroom',   color: '#ff6584' },
  // Idealz Libert Plaza — Showroom Staff (10:00 – 19:00)
  { empId: 'EMP-003', name: 'Khalid Hassan',     showroom: 'Idealz Libert Plaza', staffType: 'showroom',   color: '#43e97b' },
  { empId: 'EMP-004', name: 'Fatima Abdullah',   showroom: 'Idealz Libert Plaza', staffType: 'showroom',   color: '#f7c948' },
  // Idealz Prime — Showroom Staff (09:45 – 19:30)
  { empId: 'EMP-005', name: 'Omar Al-Farsi',     showroom: 'Idealz Prime',        staffType: 'showroom',   color: '#38b6ff' },
  // Idealz Prime — Back Office Staff (09:30 – 18:30)
  { empId: 'EMP-006', name: 'Layla Nasser',      showroom: 'Idealz Prime',        staffType: 'backoffice', color: '#ff9a4a' },
  { empId: 'EMP-007', name: 'Hassan Al-Mutairi', showroom: 'Idealz Prime',        staffType: 'backoffice', color: '#a78bfa' },
]

export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  const col = collection(db, 'employees')
  const existing = await getDocs(col)
  if (!existing.empty)
    return res.status(200).json({ message: 'Already seeded', count: existing.size })
  for (const emp of SEED_EMPLOYEES) {
    await addDoc(col, { ...emp, createdAt: Date.now() })
  }
  res.status(201).json({ message: 'Seeded successfully', count: SEED_EMPLOYEES.length })
}
