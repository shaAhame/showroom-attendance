import { db } from '../../lib/firebase'
import {
  collection, getDocs, addDoc, deleteDoc,
  doc, query, orderBy
} from 'firebase/firestore'

export default async function handler(req, res) {
  const col = collection(db, 'employees')

  if (req.method === 'GET') {
    const snap = await getDocs(query(col, orderBy('name')))
    const data = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    return res.status(200).json(data)
  }

  if (req.method === 'POST') {
    const { empId, name, showroom, staffType, color } = req.body
    if (!empId || !name || !showroom)
      return res.status(400).json({ error: 'Missing fields' })
    const ref = await addDoc(col, { empId, name, showroom, staffType: staffType || 'showroom', color: color || '#6c63ff', createdAt: Date.now() })
    return res.status(201).json({ id: ref.id, empId, name, showroom })
  }

  if (req.method === 'DELETE') {
    const { id } = req.query
    await deleteDoc(doc(db, 'employees', id))
    return res.status(200).json({ success: true })
  }

  res.status(405).json({ error: 'Method not allowed' })
}
