import { db } from '../../lib/firebase'
import { collection, addDoc, getDocs, query, where } from 'firebase/firestore'

// Only seeds the Admin account if no admin exists yet
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error:'Method not allowed' })

  const col = collection(db, 'employees')

  // Check if admin already exists
  const adminSnap = await getDocs(query(col, where('empId','==','ADMIN-01')))
  if (!adminSnap.empty) return res.status(200).json({ message:'Admin already exists' })

  // Create only the admin account
  await addDoc(col, {
    empId:     'ADMIN-01',
    name:      'HR Admin',
    showroom:  'Idealz Prime',
    staffType: 'backoffice',
    role:      'admin',
    pin:       '000000',
    color:     '#a78bfa',
    createdAt: Date.now(),
  })

  res.status(201).json({ message:'Admin account created' })
}
