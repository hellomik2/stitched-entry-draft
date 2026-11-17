'use client'

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import type { PDFDocumentProxy, PDFWorker } from 'pdfjs-dist'
import type {
  DocumentText,
  ReadingAnswer,
  VerifiedReading,
  Draft,
  DraftField,
  HtsTable,
  Override,
} from '../core'
import {
  extractDocumentText,
  verifyReadings,
  buildDraft,
  validateReadingAnswer,
  allFields,
  draftToCsv,
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
  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const redrawTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const documentsPaneRef = useRef<HTMLDivElement>(null)
  const draftPaneRef = useRef<HTMLDivElement>(null)
  const [pageScale, setPageScale] = useState(CANVAS_SCALE)

  const [svgDimensions, setSvgDimensions] = useState({ width: 0, height: 0 })
  const [threads, setThreads] = useState<Array<{ kind: 'doc' | 'calc'; d: string }>>([])
  const [overrides, setOverrides] = useState<Override[]>([])
  const [csvUrl, setCsvUrl] = useState<string | null>(null)
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
        overrides,
      })
      return { verified, draft }
    } catch (e) {
      throw new Error(`Failed to build draft: ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [documents, readingAnswer, bundle.bundle, hts, overrides])

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

  // Build map of all draft fields by id
  const fieldMap = useMemo(() => {
    if (!draft) return new Map<string, DraftField>()
    const map = new Map<string, DraftField>()
    for (const field of allFields(draft)) {
      map.set(field.id, field)
    }
    return map
  }, [draft])

  // Fit the page to the width of the documents pane (never larger than CANVAS_SCALE)
  useEffect(() => {
    if (loadState !== 'ready' || !documentsPaneRef.current) return
    const pane = documentsPaneRef.current
    const activeDoc = documents.find((d) => d.docId === activeDocId)
    const pageWidth = activeDoc?.documentText.pages[0]?.width || 612
    const fit = () => {
      // page-view has a 1rem margin on each side and a vertical scrollbar (about 16 px)
      const margins = parseFloat(getComputedStyle(document.documentElement).fontSize) * 2
      const available = pane.clientWidth - margins - 18
      const next = Math.min(CANVAS_SCALE, Math.max(0.3, Math.floor((available / pageWidth) * 100) / 100))
      setPageScale((prev) => (prev === next ? prev : next))
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(pane)
    return () => observer.disconnect()
  }, [loadState, activeDocId, documents])

  // Helper: draw threads when a field is selected
  const redrawThreads = useCallback(() => {
    if (!selectedField || !containerRef.current || !pageViewRef.current) {
      setThreads([])
      return
    }

    const field = fieldMap.get(selectedField)
    if (!field) {
      setThreads([])
      return
    }

    const container = containerRef.current
    const pageView = pageViewRef.current

    // Measure the selected value button
    const valueButton = container.querySelector<HTMLButtonElement>(
      `[data-field-id="${selectedField}"]`
    )
    if (!valueButton) {
      setThreads([])
      return
    }

    const buttonRect = valueButton.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()

    const x1 = buttonRect.left - containerRect.left + container.scrollLeft
    const y1 = buttonRect.top - containerRect.top + container.scrollTop + buttonRect.height / 2

    const newThreads: Array<{ kind: 'doc' | 'calc'; d: string }> = []

    // Doc threads: from selected value to each box in active document
    for (const source of field.sources) {
      if (source.kind === 'document' && source.doc === activeDocId) {
        const box = pageView.querySelector<HTMLDivElement>(`[data-reading="${source.readingField}"]`)
        if (box) {
          const boxRect = box.getBoundingClientRect()

          const x2 = boxRect.right - containerRect.left + container.scrollLeft
          const y2 = boxRect.top - containerRect.top + container.scrollTop + boxRect.height / 2

          // Cubic curve: M x1 y1 C x1-80 y1, x2+80 y2, x2 y2
          const d = `M ${x1} ${y1} C ${x1 - 80} ${y1}, ${x2 + 80} ${y2}, ${x2} ${y2}`
          newThreads.push({ kind: 'doc', d })
        }
      }
    }

    // Calc threads: from selected value to each input value button
    for (const inputId of field.inputs) {
      const inputButton = container.querySelector<HTMLButtonElement>(
        `[data-field-id="${inputId}"]`
      )
      if (inputButton) {
        const inputRect = inputButton.getBoundingClientRect()
        const x2 = inputRect.left - containerRect.left + container.scrollLeft
        const y2 = inputRect.top - containerRect.top + container.scrollTop + inputRect.height / 2

        // Cubic curve: M x1 y1 C x1-40 y1, x2-40 y2, x2 y2
        const d = `M ${x1} ${y1} C ${x1 - 40} ${y1}, ${x2 - 40} ${y2}, ${x2} ${y2}`
        newThreads.push({ kind: 'calc', d })
      }
    }

    setThreads(newThreads)
  }, [selectedField, fieldMap, activeDocId])

  // When a field is selected and its first source is a document, switch to that document
  useEffect(() => {
    if (!selectedField || !draft) return
    const field = fieldMap.get(selectedField)
    if (!field) return
    const first = field.sources[0]
    if (first && first.kind === 'document') {
      setActiveDocId(first.doc)
    }
  }, [selectedField, draft, fieldMap])

  // Redraw threads when selection or active doc changes
  useEffect(() => {
    if (loadState !== 'ready') return

    // Clear any pending timeout
    if (redrawTimeoutRef.current) {
      clearTimeout(redrawTimeoutRef.current)
    }

    if (!selectedField) {
      setThreads([])
      return
    }

    const field = fieldMap.get(selectedField)
    if (!field || !pageViewRef.current) {
      setThreads([])
      return
    }

    // Scroll first doc source into view
    const firstDocSource = field.sources.find(
      (s) => s.kind === 'document' && s.doc === activeDocId
    )
    if (firstDocSource && firstDocSource.kind === 'document') {
      const box = pageViewRef.current.querySelector<HTMLDivElement>(
        `[data-reading="${firstDocSource.readingField}"]`
      )
      if (box) {
        scrollIntoPane(pageViewRef.current, box)
      }
    }

    // Scroll the selected value into view inside the draft pane only
    const valueButton = draftPaneRef.current?.querySelector<HTMLElement>(
      `[data-field-id="${selectedField}"]`
    )
    if (valueButton && draftPaneRef.current) {
      scrollIntoPane(draftPaneRef.current, valueButton)
    }

    // Redraw after delay
    redrawTimeoutRef.current = setTimeout(redrawThreads, 60)

    // Also redraw after canvas render completes
    const timeoutCanvas = setTimeout(redrawThreads, 300)

    return () => {
      clearTimeout(timeoutCanvas)
    }
  }, [selectedField, activeDocId, loadState, fieldMap, redrawThreads, pageScale])

  // Update SVG dimensions when threads change or container resizes
  useEffect(() => {
    if (!containerRef.current) return

    setSvgDimensions({
      width: containerRef.current.scrollWidth,
      height: containerRef.current.scrollHeight,
    })
  }, [threads])

  // Listen for scroll and resize to redraw threads
  useEffect(() => {
    if (loadState !== 'ready' || !containerRef.current) return

    const container = containerRef.current

    const handleScroll = () => {
      if (redrawTimeoutRef.current) {
        clearTimeout(redrawTimeoutRef.current)
      }
      redrawTimeoutRef.current = setTimeout(redrawThreads, 60)
    }

    const handleResize = () => {
      if (redrawTimeoutRef.current) {
        clearTimeout(redrawTimeoutRef.current)
      }
      redrawTimeoutRef.current = setTimeout(redrawThreads, 60)
    }

    // Use capture phase to catch scroll events from panes
    container.addEventListener('scroll', handleScroll, true)
    window.addEventListener('resize', handleResize)

    return () => {
      container.removeEventListener('scroll', handleScroll, true)
      window.removeEventListener('resize', handleResize)
      if (redrawTimeoutRef.current) {
        clearTimeout(redrawTimeoutRef.current)
      }
    }
  }, [loadState, redrawThreads])

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
      const viewport = pdfPage.getViewport({ scale: pageScale * window.devicePixelRatio })

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
  }, [loadState, activeDocId, documents, pageScale])

  // Generate CSV URL when draft changes
  useEffect(() => {
    if (!draft) {
      setCsvUrl(null)
      return
    }

    const csv = draftToCsv(draft)
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    setCsvUrl(url)

    return () => {
      URL.revokeObjectURL(url)
    }
  }, [draft])

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
        {csvUrl && (
          <a
            data-testid="download-csv"
            href={csvUrl}
            download={`${bundle.bundle}-7501-draft.csv`}
            style={{ marginLeft: 'auto', paddingRight: '1rem' }}
          >
            Download CSV
          </a>
        )}
      </div>

      {/* Main layout */}
      <div
        ref={containerRef}
        style={{
          display: 'flex',
          flex: 1,
          minHeight: 0,
          position: 'relative',
        }}
      >
        {/* Left pane - documents */}
        <div ref={documentsPaneRef} data-testid="documents-pane" style={{ display: 'flex', flexDirection: 'column', width: '45%' }}>
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
              const scale = pageScale
              const left = reading.box.x * scale - 2
              const top = reading.box.y * scale - 2
              const width = reading.box.w * scale + 4
              const height = reading.box.h * scale + 4

              return (
                <div
                  key={reading.field}
                  data-testid={`box-${reading.field}`}
                  data-reading={reading.field}
                  data-selected={selectedField && fieldMap.get(selectedField)?.sources.some(
                    (s) => s.kind === 'document' && s.doc === activeDocId && s.readingField === reading.field
                  ) ? 'true' : 'false'}
                  style={{
                    position: 'absolute',
                    left: `${left}px`,
                    top: `${top}px`,
                    width: `${width}px`,
                    height: `${height}px`,
                  }}
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
        <div 
          ref={draftPaneRef}
          data-testid="draft-pane" 
          style={{ 
            width: '55%', 
            padding: '1rem', 
            background: '#fafafa', 
            overflow: 'auto',
          }}
        >
          {draft && (
            <>
              {/* 1. Needs Review Section */}
              <div data-testid="needs-review" style={{ marginBottom: '1.5rem' }}>
                <h3 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>
                  Needs review <span data-testid="needs-review-count">{draft.needsReview.length}</span>
                </h3>
                {overrides.length === 0 ? (
                  <button
                    data-testid="apply-demo-answers"
                    onClick={() => setOverrides(overridesList)}
                    style={{
                      marginBottom: '0.75rem',
                      padding: '0.5rem',
                      background: '#e8f5e9',
                      border: '1px solid #4caf50',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      fontSize: '0.875rem',
                    }}
                  >
                    Use test answers for this demo
                  </button>
                ) : (
                  <button
                    data-testid="reset-answers"
                    onClick={() => setOverrides([])}
                    style={{
                      marginBottom: '0.75rem',
                      padding: '0.5rem',
                      background: '#ffebee',
                      border: '1px solid #f44336',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      fontSize: '0.875rem',
                    }}
                  >
                    Clear person answers ({overrides.length})
                  </button>
                )}
                <p style={{ fontSize: '0.875rem', color: '#666', marginBottom: '0.75rem' }}>
                  person fills {draft.personInput.length}
                </p>
                {draft.needsReview.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {draft.needsReview.map((item) => (
                      <button
                        key={item.fieldId}
                        data-testid={`review-${item.fieldId}`}
                        onClick={() => setSelectedField(item.fieldId)}
                        style={{
                          padding: '0.5rem',
                          background: '#fff',
                          border: '1px solid #ddd',
                          borderRadius: '4px',
                          textAlign: 'left',
                          cursor: 'pointer',
                        }}
                      >
                        <div style={{ fontWeight: 500, fontSize: '0.875rem' }}>{fieldTitle(fieldMap.get(item.fieldId), item.label)}</div>
                        <div style={{ fontSize: '0.75rem', color: '#666' }}>{tidyText(item.reason)}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* 2. Header Blocks */}
              <div style={{ marginBottom: '1.5rem' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.75rem', marginBottom: '0.75rem' }}>
                  {draft.header
                    .filter((f) => f.status !== 'personInput')
                    .map((field) => (
                      <div key={field.id} className="field-card"><div className="field-card-label">{field.block}. {field.label}</div><DraftFieldButton
                        field={field}
                        selected={selectedField === field.id}
                        onSelect={() => setSelectedField(field.id)}
                      /></div>
                    ))}
                </div>

                {/* Person Input Blocks (collapsed) */}
                {draft.header.filter((f) => f.status === 'personInput').length > 0 && (
                  <details style={{ marginTop: '0.75rem' }}>
                    <summary style={{ cursor: 'pointer', fontWeight: 500, fontSize: '0.875rem' }}>
                      Person fills ({draft.header.filter((f) => f.status === 'personInput').length})
                    </summary>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.75rem', marginTop: '0.75rem' }}>
                      {draft.header
                        .filter((f) => f.status === 'personInput')
                        .map((field) => (
                          <div key={field.id} className="field-card"><div className="field-card-label">{field.block}. {field.label}</div><DraftFieldButton
                            field={field}
                            selected={selectedField === field.id}
                            onSelect={() => setSelectedField(field.id)}
                          /></div>
                        ))}
                    </div>
                  </details>
                )}
              </div>

              {/* 3. Lines Table */}
              <div style={{ marginBottom: '1.5rem' }}>
                <h3 style={{ fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.75rem' }}>Line Items</h3>
                <table data-testid="lines-table" style={{ width: '100%', fontSize: '0.75rem', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #ddd' }}>
                      <th style={{ padding: '0.375rem 0.25rem', textAlign: 'left' }}>Line</th>
                      <th style={{ padding: '0.375rem 0.25rem', textAlign: 'left' }}>Origin</th>
                      <th style={{ padding: '0.375rem 0.25rem', textAlign: 'left' }}>32</th>
                      <th style={{ padding: '0.375rem 0.25rem', textAlign: 'left' }}>33A</th>
                      <th style={{ padding: '0.375rem 0.25rem', textAlign: 'left' }}>34A</th>
                      <th style={{ padding: '0.375rem 0.25rem', textAlign: 'left' }}>35</th>
                      <th style={{ padding: '0.375rem 0.25rem', textAlign: 'left' }}>36A</th>
                      <th style={{ padding: '0.375rem 0.25rem', textAlign: 'left' }}>37A</th>
                      <th style={{ padding: '0.375rem 0.25rem', textAlign: 'left' }}>38</th>
                    </tr>
                  </thead>
                  <tbody>
                    {draft.lines.map((line) => {
                      const fieldMap = new Map(line.fields.map((f) => [f.id.split('.')[1], f]))
                      const columns = ['10', '32', '33A', '34A', '35', '36A', '37A', '38']
                      const ch99Field = line.fields.find((f) => f.id.endsWith('.ch99'))

                      return (
                        <tr key={line.lineNumber} data-testid={`line-${line.lineNumber}`} style={{ borderBottom: '1px solid #eee' }}>
                          <td style={{ padding: '0.375rem 0.25rem', fontWeight: 500 }}>
                            {line.lineNumber}
                            <div style={{ fontSize: '0.65rem', color: '#666' }}>inv {line.invoiceLines.join('+')}</div>
                          </td>
                          {columns.map((col) => {
                            const field = fieldMap.get(col)
                            return (
                              <td key={col} style={{ padding: '0.375rem 0.25rem' }}>
                                {field ? (
                                  <>
                                    <DraftFieldButton
                                      field={field}
                                      selected={selectedField === field.id}
                                      onSelect={() => setSelectedField(field.id)}
                                      compact
                                    />
                                    {col === '38' && ch99Field && (
                                      <div style={{ marginTop: '0.25rem' }}>
                                        <DraftFieldButton
                                          field={ch99Field}
                                          selected={selectedField === ch99Field.id}
                                          onSelect={() => setSelectedField(ch99Field.id)}
                                          compact
                                        />
                                      </div>
                                    )}
                                  </>
                                ) : null}
                              </td>
                            )
                          })}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {/* 4. Totals Cards */}
              <div style={{ marginBottom: '1.5rem' }}>
                <h3 style={{ fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.75rem' }}>Totals</h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.75rem' }}>
                  {draft.totals.map((field) => (
                    <div key={field.id} className="field-card"><div className="field-card-label">{field.id.startsWith('FEE.') ? `Part of ${field.block} · ${field.label}` : `${field.block}. ${field.label}`}</div><DraftFieldButton
                      field={field}
                      selected={selectedField === field.id}
                      onSelect={() => setSelectedField(field.id)}
                    /></div>
                  ))}
                </div>
              </div>

              {/* 5. Checks (collapsed) */}
              {draft.checks.length > 0 && (
                <details style={{ marginBottom: '1.5rem' }}>
                  <summary style={{ cursor: 'pointer', fontWeight: 500, fontSize: '0.875rem' }}>
                    Checks ({draft.checks.length})
                  </summary>
                  <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {draft.checks.map((check) => (
                      <div
                        key={check.id}
                        data-testid={`check-${check.id}`}
                        data-ok={check.ok ? 'true' : 'false'}
                        style={{
                          padding: '0.5rem',
                          background: check.ok ? '#f0f8f0' : '#fff0f0',
                          border: `1px solid ${check.ok ? '#0a0' : '#f00'}`,
                          borderRadius: '4px',
                          fontSize: '0.75rem',
                        }}
                      >
                        <div style={{ fontWeight: 500 }}>{check.label}</div>
                        {check.detail && <div style={{ color: '#666', marginTop: '0.25rem' }}>{check.detail}</div>}
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </>
          )}
        </div>

        {/* Threads SVG overlay */}
        <svg
          ref={svgRef}
          data-testid="threads"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: `${svgDimensions.width}px`,
            height: `${svgDimensions.height}px`,
            pointerEvents: 'none',
            zIndex: 5,
            overflow: 'visible',
          }}
        >
          {threads.map((thread, idx) => (
            <path
              key={idx}
              data-testid={thread.kind === 'doc' ? 'thread-doc' : 'thread-calc'}
              d={thread.d}
              fill="none"
              strokeWidth={2}
              strokeDasharray="6 4"
              stroke={thread.kind === 'doc' ? '#2563eb' : '#daa520'}
            />
          ))}
        </svg>
      </div>

      {/* Source Strip */}
      <SourceStrip 
        selectedField={selectedField} 
        fieldMap={fieldMap} 
        draft={draft}
        documents={bundle.documents}
        onApply={(fieldId, value) => {
          setOverrides((prev) => [...prev.filter((o) => o.fieldId !== fieldId), { fieldId, value }])
        }}
        onUndo={(fieldId) => {
          setOverrides((prev) => prev.filter((o) => o.fieldId !== fieldId))
        }}
        onSelect={setSelectedField}
      />
    </div>
  )
}

/**
 * Where a draft field sits on the 7501, for labels:
 * "Line 004 · 38 Duty (USD)", "Block 41 · Duty (USD)", or
 * "Part of block 43 · Merchandise processing fee (USD)" for the fee fields (FEE.*) that add up into Block 43.
 */
function fieldTitle(field: DraftField | undefined, fallback: string): string {
  if (!field) return fallback
  if (field.line) return `Line ${field.line} · ${field.block} ${field.label}`
  if (field.id.startsWith('FEE.')) return `Part of block ${field.block} · ${field.label}`
  return `Block ${field.block} · ${field.label}`
}

/**
 * Display only: fold a doubled word ("See See") and a doubled full stop ("08..") in reason text.
 * The draft and the CSV keep the original text.
 */
function tidyText(text: string): string {
  return text.replace(/\b([A-Za-z]+) \1\b/g, '$1').replace(/(?<!\.)\.\.(?!\.)/g, '.')
}

/**
 * Scroll `pane` vertically, and only `pane`, so that `el` is inside its visible area.
 * Does nothing when `el` is already visible or not rendered (for example inside a closed <details>).
 */
function scrollIntoPane(pane: HTMLElement, el: HTMLElement) {
  const r = el.getBoundingClientRect()
  if (r.width === 0 && r.height === 0) return
  const p = pane.getBoundingClientRect()
  const top = p.top + 16
  const bottom = p.top + pane.clientHeight - 16
  if (r.top < top) {
    pane.scrollTop -= top - r.top
  } else if (r.bottom > bottom) {
    pane.scrollTop += Math.min(r.bottom - bottom, r.top - top)
  }
}

/**
 * DraftFieldButton: renders a single draft field as a button
 */
function DraftFieldButton({
  field,
  selected,
  onSelect,
  compact = false,
}: {
  field: DraftField
  selected: boolean
  onSelect: () => void
  compact?: boolean
}) {
  const statusStyles: Record<string, React.CSSProperties> = {
    copied: { background: '#f5f5f5', border: '1px solid #ddd' },
    computed: { background: '#fffacd', border: '1px solid #daa520' },
    needsReview: { background: '#fff', border: '2px dashed #f00' },
    personInput: { background: '#f0f0f0', border: '2px dashed #999' },
    personEdited: { background: '#e3f2fd', border: '2px dashed #2196f3' },
  }

  const baseStyle = {
    padding: compact ? '0.25rem 0.375rem' : '0.5rem',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: compact ? '0.7rem' : '0.75rem',
    textAlign: 'left' as const,
    ...statusStyles[field.status],
    ...(selected && { boxShadow: '0 0 4px rgba(0,0,0,0.3)' }),
  }

  const displayText = field.value || (field.status === 'needsReview' ? 'needs review' : 'person fills')
  const text = field.value && field.unit ? `${field.value} ${field.unit}` : displayText

  return (
    <button
      data-testid={`field-${field.id}`}
      data-field-id={field.id}
      data-status={field.status}
      onClick={onSelect}
      style={baseStyle}
      title={field.label}
    >
      {text}
    </button>
  )
}

/**
 * SourceStrip: last row of the board showing sources for the selected field
 */
function SourceStrip({
  selectedField,
  fieldMap,
  draft,
  documents,
  onApply,
  onUndo,
  onSelect,
}: {
  selectedField: string | null
  fieldMap: Map<string, DraftField>
  draft: Draft | null
  documents: Array<{ docId: string; label: string }>
  onApply: (fieldId: string, value: string) => void
  onUndo: (fieldId: string) => void
  onSelect: (fieldId: string) => void
}) {
  const field = selectedField && fieldMap ? fieldMap.get(selectedField) : null
  const docMap = new Map(documents.map((d) => [d.docId, d.label]))

  const statusWords: Record<string, string> = {
    copied: 'Copied from a document',
    computed: 'Computed',
    needsReview: 'Needs review',
    personInput: 'A person fills this',
    personEdited: 'Entered by a person',
  }

  return (
    <div
      data-testid="source-strip"
      style={{
        position: 'relative',
        zIndex: 10,
        flex: '0 0 auto',
        minHeight: '9rem',
        background: '#fff',
        borderTop: '1px solid #ddd',
        padding: '0.75rem 1rem',
        fontSize: '0.75rem',
        maxHeight: '12rem',
        overflowY: 'auto',
        lineHeight: 1.4,
      }}
    >
      {!field ? (
        <div style={{ color: '#999', minHeight: '7rem', display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
          Click any value in the draft to see where it came from: the document line, the tariff row, or the values it was computed from.
        </div>
      ) : (
        <>
          {/* Header: Block and label */}
          <div style={{ marginBottom: '0.5rem', fontWeight: 500 }}>
            {fieldTitle(field, field.label)}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', columnGap: '1.5rem', alignItems: 'start' }}>
            <div>
              {/* Status, with the value form or the Undo button on the same row */}
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: '0.75rem', rowGap: '0.25rem', marginBottom: '0.5rem' }}>
                <span data-testid="strip-status" style={{ color: '#666' }}>{statusWords[field.status]}</span>

              {/* Override form for needsReview or personInput */}
              {(field.status === 'needsReview' || field.status === 'personInput') && (
                <form
                  key={field.id}
                  onSubmit={(e) => {
                    e.preventDefault()
                    const v = String(new FormData(e.currentTarget).get('value') ?? '').trim()
                    if (v) onApply(field.id, v)
                  }}
                  style={{ margin: 0 }}
                >
                  <input
                    name="value"
                    data-testid="override-input"
                    placeholder="Value decided by a person"
                    style={{
                      padding: '0.5rem',
                      marginRight: '0.5rem',
                      borderRadius: '4px',
                      border: '1px solid #ddd',
                      fontSize: '0.75rem',
                    }}
                  />
                  <button
                    type="submit"
                    data-testid="override-apply"
                    style={{
                      padding: '0.5rem 1rem',
                      background: '#2196f3',
                      color: '#fff',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      fontSize: '0.75rem',
                    }}
                  >
                    Use this value
                  </button>
                </form>
              )}

              {/* Undo button for personEdited */}
              {field.status === 'personEdited' && (
                <button
                  data-testid="override-undo"
                  onClick={() => onUndo(field.id)}
                  style={{
                    padding: '0.5rem 1rem',
                    background: '#ff9800',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '0.75rem',
                  }}
                >
                  Undo
                </button>
              )}
              </div>

              {/* Reason */}
              {field.reason && (
                <div style={{ marginBottom: '0.5rem', color: '#f00' }} data-testid="strip-reason">
                  Reason: {tidyText(field.reason)}
                </div>
              )}

              {/* Value */}
              {field.value && (
                <div style={{ marginBottom: '0.5rem' }}>
                  <span data-testid="strip-value" style={{ fontWeight: 500 }}>
                    {field.value}
                    {field.unit && ` ${field.unit}`}
                  </span>
                </div>
              )}

              {/* Rule */}
              {field.rule && (
                <div style={{ marginBottom: '0.5rem', color: '#555' }}>
                  Rule: <em>{field.rule}</em>
                </div>
              )}

              {/* Note */}
              {field.note && (
                <div style={{ marginBottom: '0.5rem', color: '#555' }}>
                  Note: {field.note}
                </div>
              )}
            </div>
            <div>
              {/* Sources */}
              {field.sources.length > 0 && (
                <div style={{ marginBottom: '0.5rem' }}>
                  {field.sources.map((source, idx) => (
                    <div
                      key={idx}
                      data-testid="strip-source"
                      style={{ marginBottom: '0.25rem', color: '#333' }}
                    >
                      {source.kind === 'document'
                        ? `${docMap.get(source.doc) || source.doc} p.${source.page}: "${source.quote}"`
                        : `Tariff schedule ${source.revision}, row ${source.htsno}`}
                    </div>
                  ))}
                </div>
              )}

              {/* Input links */}
              {field.inputs.length > 0 && (
                <div style={{ fontSize: '0.7rem', color: '#0070f3' }}>
                  Inputs: {field.inputs.map((id) => (
                    <button
                      key={id}
                      onClick={() => onSelect(id)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: '#0070f3',
                        textDecoration: 'underline',
                        cursor: 'pointer',
                        padding: 0,
                        marginRight: '0.75rem',
                      }}
                    >
                      {[id, fieldMap.get(id)?.label].filter(Boolean).join(' ')}
                    </button>
                  ))}</div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
