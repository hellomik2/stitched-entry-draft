import type { Metadata } from 'next'
import React from 'react'
import './globals.css'
import { PAGE_TITLE } from './appTitle'

export const metadata: Metadata = {
  title: PAGE_TITLE,
  description: 'Line-by-line CBP Form 7501 draft where every value is stitched to the document line or the values it came from. Draft only, not for filing.',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
