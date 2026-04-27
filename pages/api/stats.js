import { db } from '../../lib/firebase'
import { collection, getDocs, query, where } from 'firebase/firestore'

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const today = new Date().toISOString().split('T')[0]
  const col = collection(db, 'records')
  const snap = await getDocs(query(col, where('date', '==', today)))
  const recs = snap.docs.map(d => d.data())

  const arrived  = new Set(recs.filter(r => r.type === 'arrive').map(r => r.empId)).size
  const departed = new Set(recs.filter(r => r.type === 'depart').map(r => r.empId)).size
  const onLeave  = new Set(recs.filter(r => r.type === 'leave').map(r => r.empId)).size

  const showrooms = ['Idealz Marino', 'Idealz Libert Plaza', 'Idealz Prime']
  const byShowroom = {}
  for (const s of showrooms) {
    byShowroom[s] = new Set(
      recs.filter(r => r.showroom === s && r.type === 'arrive').map(r => r.empId)
    ).size
  }

  res.status(200).json({ arrived, departed, onLeave, byShowroom, total: recs.length })
}
