import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'INPS Extractor — Quadri E0/V1',
  description: 'Estrazione selettiva colonne da file INPS PASSWEB · Immedia S.p.A.',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="it">
      <body className="bg-gray-50 min-h-screen">{children}</body>
    </html>
  )
}
