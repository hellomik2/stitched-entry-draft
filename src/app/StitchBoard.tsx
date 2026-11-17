'use client'

import React, { useState, useEffect, useRef, useMemo } from 'react'
import type { PDFDocumentProxy, PDFWorker } from 'pdfjs-dist'
import type {
  DocumentText,
  ReadingAnswer,
  VerifiedReading,
  Draft,
  HtsTable,
  Override,
} from '../core'
import {
  extractDocumentText,
  verifyReadings,
  buildDraft,
  validateReadingAnswer,
} from '../core'

export interface BundleJson {
  bundle: string
  title: string
  documents: Array<{
    docId: string
    kind: 'invoice' | 'packingList' | 'billOfLading'
    file: string
    label: string
  }>
}

interface StitchBoardProps {
  bundle: BundleJson
  reading: unknown
  overrides: unknown
  hts: HtsTable
}

interface LoadedDocument {
  docId: string
  pdf: PDFDocumentProxy
  documentText: DocumentText
}

const CANVAS_SCALE = 0.95

export default function StitchBoard({
  bundle,
  reading: readingData,
  overrides: overridesData,
  hts,
}: StitchBoardProps) {
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [documents, setDocuments] = useState<LoadedDocument[]>([])
  const [activeDocId, setActiveDocId] = useState<string | null>(null)
  const [selectedField, setSelectedField] = useState<string | null>(null)

  const pageViewRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const taskRef = useRef<{ promise: Promise<void>; cancel: () => void } | null>(null)
  const cancelledRef = useRef(false)

  // Parse and validate reading data
  const readingAnswer = useMemo(() => {
    try {
      const validation = validateReadingAnswer(readingData)
      if (!validation.ok) {
        throw new Error(`Invalid reading answer: ${validation.reason}`)
      }
      return validation.value
    } catch (e) {
      throw new Error(`Failed to parse reading.json: ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [readingData])

  // Parse overrides
  const overridesList = useMemo(() => {
    try {
      const data = overridesData as Record<string, unknown>
      if (!Array.isArray(data.overrides)) {
        throw new Error('overrides must be an array')
      }
      return data.overrides as Override[]
    } catch (e) {
      throw new Error(`Failed to parse overrides: ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [overridesData])

  // Verify readings and build draft
  const { verified, draft } = useMemo(() => {
    if (documents.length === 0) {
      return { verified: [] as VerifiedReading[], draft: null }
    }
    try {
      const documentTexts = documents.map((d) => d.documentText)
      const verified = verifyReadings(readingAnswer, documentTexts)
      const draft = buildDraft({
        bundle: bundle.bundle,
        reader: readingAnswer.reader,
        readings: verified,
        hts,
        overrides: [],
      })
      return { verified, draft }
    } catch (e) {
      throw new Error(`Failed to build draft: ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [documents, readingAnswer, bundle.bundle, hts, overridesList])

  // Load all PDF documents
  useEffect(() => {
    const loadDocuments = async () => {
      try {
        const pdfjs = await import('pdfjs-dist')
        pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'

        const loaded: LoadedDocument[] = []

        for (const docConfig of bundle.documents) {
          const pdfUrl = `/samples/${bundle.bundle}/${docConfig.file}`

          // Load PDF
          const pdfDoc = await pdfjs.getDocument({
            url: pdfUrl,
            standardFontDataUrl: '/standard_fonts/',
          }).promise

          // Extract text
          const documentText = await extractDocumentText(pdfDoc, docConfig.docId, docConfig.kind)

          loaded.push({
            docId: docConfig.docId,
            pdf: pdfDoc,
            documentText,
          })
        }

        setDocuments(loaded)
        setActiveDocId(loaded[0]?.docId || null)
        setLoadState('ready')
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        setError(message)
        setLoadState('error')
      }
    }

    loadDocuments()
  }, [bundle])

  // Render active document page
  useEffect(() => {
    if (loadState !== 'ready' || !activeDocId || !pageViewRef.current) {
      return
    }

    cancelledRef.current = false

    const renderPage = async () => {
      const activeDoc = documents.find((d) => d.docId === activeDocId)
      if (!activeDoc) return

      const pdfPage = await activeDoc.pdf.getPage(1)
      const viewport = pdfPage.getViewport({ scale: CANVAS_SCALE * window.devicePixelRatio })

      // Create new canvas for this render
      const canvas = document.createElement('canvas')
      canvas.width = viewport.width
      canvas.height = viewport.height
      canvas.style.width = `${viewport.width / window.devicePixelRatio}px`
      canvas.style.height = `${viewport.height / window.devicePixelRatio}px`

      const task = pdfPage.render({
        canvas,
        canvasContext: canvas.getContext('2d')!,
        viewport,
      })

      taskRef.current = {
        promise: task.promise,
        cancel: () => task.cancel(),
      }

      try {
        await task.promise

        // Only swap canvas if not cancelled
        if (!cancelledRef.current && pageViewRef.current) {
          // Remove old canvas
          if (canvasRef.current) {
            canvasRef.current.remove()
          }
          canvasRef.current = canvas
          canvas.style.display = 'block'
          pageViewRef.current.insertBefore(canvas, pageViewRef.current.firstChild)
        }
      } catch (e) {
        if ((e as Error).name !== 'RenderingCancelledException') {
          console.error('PDF render error:', e)
        }
      }
    }

    renderPage()

    return () => {
      cancelledRef.current = true
      if (taskRef.current) {
        taskRef.current.cancel()
      }
    }
  }, [loadState, activeDocId, documents])

  if (loadState === 'loading') {
    return <div data-testid="loading">Loading documents...</div>
  }

  if (loadState === 'error') {
    return (
      <div data-testid="load-error">
        <div>Failed to load documents</div>
        <code>{error}</code>
      </div>
    )
  }

  // Get readings for active document, page 1 only
  const activeReadings = verified.filter(
    (r): r is Extract<VerifiedReading, { status: 'accepted' }> => r.doc === activeDocId && r.page === 1 && r.status === 'accepted'
  )
  const rejectedReadings = verified.filter((r): r is Extract<VerifiedReading, { status: 'rejected' }> => r.doc === activeDocId && r.page === 1 && r.status === 'rejected')

  // Get page dimensions for canvas
  const activeDoc = documents.find((d) => d.docId === activeDocId)
  const pageWidth = activeDoc?.documentText.pages[0]?.width || 612
  const pageHeight = activeDoc?.documentText.pages[0]?.height || 792

  return (
    <div data-testid="stitch-board" style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Top bar */}
      <div data-testid="top-bar">
        <div data-testid="draft-notice">{draft?.notice || 'DRAFT, NOT FOR FILING'}</div>
        <div data-testid="hts-revision">
          Checked against {draft?.htsRevisionTitle || 'HTS Revision (loading)'}
        </div>
        <div data-testid="reader-mode">Pre-read sample: no AI call</div>
      </div>

      {/* Main layout */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* Left pane - documents */}
        <div data-testid="documents-pane" style={{ display: 'flex', flexDirection: 'column', width: '50%' }}>
          {/* Document tabs */}
          <div data-testid="document-tabs">
            {bundle.documents.map((doc) => (
              <button
                key={doc.docId}
                data-testid={`tab-${doc.docId}`}
                role="tab"
                aria-selected={activeDocId === doc.docId}
                onClick={() => setActiveDocId(doc.docId)}
              >
                {doc.label}
              </button>
            ))}
          </div>

          {/* Page view */}
          <div
            data-testid="page-view"
            ref={pageViewRef}
            style={{
              flex: 1,
              position: 'relative',
              overflow: 'auto',
              background: '#fff',
              alignSelf: 'flex-start',
              margin: '1rem',
            }}
          >
            {/* Reading boxes overlaid on canvas */}
            {activeReadings.map((reading) => {
              const scale = CANVAS_SCALE
              const left = reading.box.x * scale - 2
              const top = reading.box.y * scale - 2
              const width = reading.box.w * scale + 4
              const height = reading.box.h * scale + 4

              return (
                <div
                  key={reading.field}
                  data-testid={`box-${reading.field}`}
                  data-reading={reading.field}
                  data-selected={selectedField === reading.field ? 'true' : 'false'}
                  style={{
                    position: 'absolute',
                    left: `${left}px`,
                    top: `${top}px`,
                    width: `${width}px`,
                    height: `${height}px`,
                  }}
                  onClick={() => setSelectedField(reading.field)}
                />
              )
            })}
          </div>

          {/* Rejected readings */}
          <div data-testid="rejected-readings">
            {rejectedReadings.map((reading) => (
              <div key={reading.field}>
                <span className="field-name">{reading.field}</span>
                <span className="reason">{reading.status === 'rejected' ? reading.message : ''}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Right pane - draft */}
        <div data-testid="draft-pane" style={{ width: '50%', padding: '1rem', background: '#fafafa', overflow: 'auto' }}>
          <h2>Draft Summary</h2>
          {draft && (
            <div>
              <p>
                <strong>Bundle:</strong> {draft.bundle}
              </p>
              <p>
                <strong>Reader:</strong> {draft.reader}
              </p>
              <p>
                <strong>Lines:</strong> {draft.lines.length}
              </p>
              <p>
                <strong>Needs Review:</strong> {draft.needsReview.length}
              </p>
              <p>
                <strong>Person Input:</strong> {draft.personInput.length}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
