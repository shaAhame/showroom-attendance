import { db } from '../../lib/firebase'
import {
  collection, getDocs, addDoc,
  query, where, orderBy
} from 'firebase/firestore'

export default async function handler(req, res) {
  const col = collection(db, 'records')

  if (req.method === 'GET') {
    const { showroom, emp_id, date, type } = req.query
    let constraints = [orderBy('createdAt', 'desc')]
    if (showroom) constraints.push(where('showroom', '==', showroom))
    if (emp_id)   constraints.push(where('empId',    '==', emp_id))
    if (date)     constraints.push(where('date',     '==', date))
    if (type)     constraints.push(where('type',     '==', type))

    try {
      const snap = await getDocs(query(col, ...constraints))
      const data = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      return res.status(200).json(data)
    } catch (e) {
      // Firestore requires composite index for multi-field queries
      // Fall back to unfiltered + client-side filter
      const snap = await getDocs(query(col, orderBy('createdAt', 'desc')))
      let data = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      if (showroom) data = data.filter(r => r.showroom === showroom)
      if (emp_id)   data = data.filter(r => r.empId    === emp_id)
      if (date)     data = data.filter(r => r.date     === date)
      if (type)     data = data.filter(r => r.type     === type)
      return res.status(200).json(data)
    }
  }

  if (req.method === 'POST') {
    const { empId, empName, showroom, type, date, time, reason, duration } = req.body
    if (!empId || !showroom || !type)
      return res.status(400).json({ error: 'Missing fields' })
    const ref = await addDoc(col, {
      empId, empName, showroom, type, date, time,
      reason: reason || '',
      duration: duration || 0,
      createdAt: Date.now()
    })
    return res.status(201).json({ id: ref.id })
  }

  res.status(405).json({ error: 'Method not allowed' })
}
