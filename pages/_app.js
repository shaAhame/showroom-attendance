import '../styles/globals.css'
import { useEffect } from 'react'

export default function App({ Component, pageProps }) {
  useEffect(() => {
    // Seed admin account on first ever load
    fetch('/api/seed', { method: 'POST' }).catch(() => {})
  }, [])

  return <Component {...pageProps} />
}
