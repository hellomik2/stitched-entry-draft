'use client'

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import type { PDFDocumentProxy, PDFWorker } from 'pdfjs-dist'
import type {
  DocumentText,
  ReadingAnswer,
  VerifiedReading,
  Draft,
  DraftField,
  DocSource,
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
  readerOutputToAnswer,
  composeDocumentTexts,
  LOW_CONFIDENCE_REVIEW_REASON,
  CONFIRMED_NOTE,
  isImageReviewReason,
} from '../core'
import UploadPanel, { type UploadResult } from './intake/UploadPanel'
import { APP_NAME, BOARD_TITLE } from './appTitle'

export interface BundleJson {
  bundle: string
  title: string
  documents: Array<{
    docId: string
    kind: 'invoice' | 'packingList' | 'billOfLading' | 'partsList'
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
  pdf: PDFDocumentProxy | null
  image: HTMLImageElement | null
  documentText: DocumentText
}

const CANVAS_SCALE = 0.95

// Requirement 43: the "AI estimate" label sits beside its box so it does not cover the line above.
const APPROX_LABEL_ROOM_PX = 96
function approxLabelSide(left: number, width: number, pageWidthPx: number): 'right' | 'left' | 'above' {
  if (pageWidthPx - (left + width) >= APPROX_LABEL_ROOM_PX) return 'right'
  if (left >= APPROX_LABEL_ROOM_PX) return 'left'
  return 'above'
}

/** Thread colours: blue to a document line, gold to the values a field is computed from. */
const THREAD_DOC_COLOR = '#2563eb'
const THREAD_CALC_COLOR = '#b8860b'
/** Cross stitches drawn over every thread (and later in the legend): short bars across the line. */
const STITCH = { width: 5, dash: '1.5 5', opacity: 0.8 }

const KIND_LABEL = {
  invoice: 'Commercial invoice',
  packingList: 'Packing list',
  billOfLading: 'Bill of lading',
  partsList: 'Customer parts list',
}

/** Calculate the width needed to draw all text in a sheet page, including text that runs into empty cells */
function sheetDrawnWidth(pageText: { width: number; height: number; items: Array<{ str: string; box: { x: number; y: number; w: number; h: number } }> }): number {
  if (typeof document === 'undefined') {
    // Server render: no canvas available
    return pageText.width
  }

  const fontSize = `${Math.min(10, Math.max(6, pageText.height * 0.05))}px sans-serif`
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return pageText.width

  ctx.font = fontSize
  
  let need = pageText.width
  for (const item of pageText.items) {
    // Check if this item has another item to its right in the same row
    const hasItemToRight = pageText.items.some(
      (o) => o !== item && Math.abs(o.box.y - item.box.y) < 0.01 && o.box.x > item.box.x
    )
    if (!hasItemToRight) {
      // No item to the right: measure the text width
      const measured = ctx.measureText(item.str).width
      need = Math.max(need, item.box.x + 3 + measured + 4)
    }
  }

  return need
}

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
  const [activePage, setActivePage] = useState(1)
  const [selectedField, setSelectedField] = useState<string | null>(null)
  const [upload, setUpload] = useState<UploadResult | null>(null)
  const [showUpload, setShowUpload] = useState(false)

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
      if (upload) {
        // Upload mode: build answer from upload
        return readerOutputToAnswer(upload.prepared.input, upload.output)
      }
      // Sample mode: use the provided reading data
      const validation = validateReadingAnswer(readingData)
      if (!validation.ok) {
        throw new Error(`Invalid reading answer: ${validation.reason}`)
      }
      return validation.value
    } catch (e) {
      throw new Error(`Failed to parse reading.json: ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [readingData, upload])

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

  // Determine the active bundle (sample or uploaded)
  const activeBundle: BundleJson = upload
    ? {
        bundle: 'uploaded',
        title: 'Your uploaded documents (not stored)',
        documents: [
          ...upload.prepared.views.map((v) => ({
            docId: v.docId,
            kind: v.kind as 'invoice' | 'packingList' | 'billOfLading',
            file: v.fileName,
            label: `${KIND_LABEL[v.kind]}: ${v.fileName}`,
          })),
          ...(upload.partsList
            ? [{
                docId: 'partsList',
                kind: 'partsList' as const,
                file: upload.partsList.fileName,
                label: `${KIND_LABEL['partsList']}: ${upload.partsList.fileName}`,
              }]
            : []),
        ],
      }
    : bundle

  // Verify readings and build draft
  const { verified, draft } = useMemo(() => {
    if (documents.length === 0) {
      return { verified: [] as VerifiedReading[], draft: null }
    }
    try {
      const documentTexts = documents.filter((d) => d.docId !== 'partsList').map((d) => d.documentText)
      const verified = verifyReadings(readingAnswer, documentTexts)
      const draft = buildDraft({
        bundle: activeBundle.bundle,
        reader: readingAnswer.reader,
        readings: verified,
        hts,
        overrides,
        invoiceLineCount: readingAnswer.invoiceLineCount ?? null,
        packingListLineCount: readingAnswer.packingListLineCount ?? null,
        partsList: upload?.partsList?.list ?? null,
      })
      return { verified, draft }
    } catch (e) {
      throw new Error(`Failed to build draft: ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [documents, readingAnswer, activeBundle.bundle, hts, overrides])

  // Load all PDF documents (sample mode only)
  useEffect(() => {
    if (upload !== null) {
      // Upload mode: skip sample loading
      return
    }

    const loadDocuments = async () => {
      try {
        const pdfjs = await import('pdfjs-dist')
        pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'

        const loaded: LoadedDocument[] = []

        for (const docConfig of bundle.documents) {
          if (docConfig.kind === 'partsList') continue // a parts list is never a sample PDF
          const pdfUrl = `/samples/${bundle.bundle}/${docConfig.file}`

          // Load PDF
          const pdfDoc = await pdfjs.getDocument({
            url: pdfUrl,
            standardFontDataUrl: '/standard_fonts/',
          }).promise

          // Extract text
          const documentText = await extractDocumentText(pdfDoc, docConfig.docId, docConfig.kind as DocumentText['kind'])

          loaded.push({
            docId: docConfig.docId,
            pdf: pdfDoc,
            image: null,
            documentText,
          })
        }

        setDocuments(loaded)
        setActiveDocId(loaded[0]?.docId || null)
        setActivePage(1)
        setLoadState('ready')
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        setError(message)
        setLoadState('error')
      }
    }

    loadDocuments()
  }, [bundle, upload])

  // Load uploaded documents (upload mode)
  useEffect(() => {
    if (!upload) {
      return
    }

    const loadUploadedDocuments = async () => {
      try {
        // Compose document texts from prepared data and reader output
        const texts = composeDocumentTexts(
          upload.prepared.textDocs,
          upload.prepared.input,
          upload.output
        )

        const loaded: LoadedDocument[] = []

        for (const view of upload.prepared.views) {
          const documentText = texts.find((t) => t.docId === view.docId)
          if (!documentText) {
            throw new Error(`Text document ${view.docId} not found`)
          }

          let image: HTMLImageElement | null = null

          // For image pages, create an HTMLImageElement from the image URL
          if (view.imageUrl) {
            const img = new Image()
            img.src = view.imageUrl
            await img.decode()
            image = img
          }

          loaded.push({
            docId: view.docId,
            pdf: view.pdf,
            image,
            documentText,
          })
        }

        // Add parts list document if present
        if (upload.partsList) {
          loaded.push({
            docId: 'partsList',
            pdf: null,
            image: null,
            documentText: { docId: 'partsList', kind: 'invoice', pages: [upload.partsList.list.page] },
          })
        }

        setDocuments(loaded)
        setActiveDocId(loaded[0]?.docId || null)
        setActivePage(1)
        setSelectedField(null)
        setOverrides([])
        setLoadState('ready')
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        setError(message)
        setLoadState('error')
      }
    }

    loadUploadedDocuments()
  }, [upload])

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
    const activePageText = activeDoc?.documentText.pages.find((p) => p.page === activePage) ?? activeDoc?.documentText.pages[0]
    const pageWidth = activePageText?.origin === 'sheet' ? sheetDrawnWidth(activePageText!) : (activePageText?.width || 612)
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
  }, [loadState, activeDocId, activePage, documents])

  // Helper: draw threads when a field is selected.
  // A thread leaves a value through the gap just left of it and runs along the gap above its table row
  // or card before it crosses over, so it never runs across other values.
  const redrawThreads = useCallback(() => {
    if (!selectedField || !containerRef.current || !pageViewRef.current || !draftPaneRef.current) {
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

    // Measure the selected value button (not drawn when it is hidden, for example inside a closed <details>)
    const valueButton = container.querySelector<HTMLButtonElement>(
      `[data-field-id="${selectedField}"]`
    )
    if (!valueButton || !isRendered(valueButton)) {
      setThreads([])
      return
    }

    const containerRect = container.getBoundingClientRect()
    const toLocal = (r: DOMRect) => ({
      left: r.left - containerRect.left + container.scrollLeft,
      right: r.right - containerRect.left + container.scrollLeft,
      top: r.top - containerRect.top + container.scrollTop,
      bottom: r.bottom - containerRect.top + container.scrollTop,
    })
    // Where a thread meets a value: its left middle, the gap just left of it, the gap just above its row or card
    const anchorOf = (el: HTMLElement) => {
      const r = toLocal(el.getBoundingClientRect())
      const row = el.closest<HTMLElement>('tr, .field-card')
      const rowTop = row ? toLocal(row.getBoundingClientRect()).top : r.top
      return {
        x: r.left,
        y: (r.top + r.bottom) / 2,
        gapX: r.left - 4,
        laneY: rowTop - (row && row.tagName === 'TR' ? 1 : 5),
      }
    }

    const a = anchorOf(valueButton)
    const gutterX = toLocal(draftPaneRef.current.getBoundingClientRect()).left + 4

    const newThreads: Array<{ kind: 'doc' | 'calc'; d: string }> = []

    // Doc threads: up to the gap above the value's row, left to the edge of the draft pane, then a curve to the box
    for (const source of field.sources) {
      if (source.kind === 'document' && source.doc === activeDocId && source.page === activePage) {
        const box = pageView.querySelector<HTMLDivElement>(`[data-reading="${source.readingField}"]`)
        if (box) {
          const b = toLocal(box.getBoundingClientRect())
          const x2 = b.right
          const y2 = (b.top + b.bottom) / 2
          const d =
            roundedPath([[a.x, a.y], [a.gapX, a.y], [a.gapX, a.laneY], [gutterX, a.laneY]]) +
            ` C ${gutterX - 60} ${a.laneY}, ${x2 + 60} ${y2}, ${x2} ${y2}`
          newThreads.push({ kind: 'doc', d })
        }
      }
    }

    // Calc threads: along the gaps between values to each input value
    for (const inputId of field.inputs) {
      const inputButton = container.querySelector<HTMLButtonElement>(
        `[data-field-id="${inputId}"]`
      )
      if (inputButton && isRendered(inputButton)) {
        const b = anchorOf(inputButton)
        const points: Array<[number, number]> =
          Math.abs(a.gapX - b.gapX) < 2
            ? [[a.x, a.y], [a.gapX, a.y], [b.gapX, b.y], [b.x, b.y]]
            : [[a.x, a.y], [a.gapX, a.y], [a.gapX, b.laneY], [b.gapX, b.laneY], [b.gapX, b.y], [b.x, b.y]]
        newThreads.push({ kind: 'calc', d: roundedPath(points) })
      }
    }

    setThreads(newThreads)
  }, [selectedField, fieldMap, activeDocId, activePage])

  // When a field is selected and its first source is a document, switch to that document
  useEffect(() => {
    if (!selectedField || !draft) return
    const field = fieldMap.get(selectedField)
    if (!field) return
    const first = field.sources[0]
    if (first && first.kind === 'document') {
      setActiveDocId(first.doc)
      setActivePage(first.page)
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

    // Scroll first doc source on the active page into view
    const firstDocSource = field.sources.find(
      (s) => s.kind === 'document' && s.doc === activeDocId && s.page === activePage
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
  }, [selectedField, activeDocId, activePage, loadState, fieldMap, redrawThreads, pageScale])

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

      if (activeDoc.pdf) {
        // PDF page rendering
        const pdfPage = await activeDoc.pdf.getPage(activePage)
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
      } else if (activeDoc.image) {
        // Image page rendering
        const activePageText = activeDoc.documentText.pages.find((p) => p.page === activePage) ?? activeDoc.documentText.pages[0]
        const pageWidth = activePageText?.width || 612
        const pageHeight = activePageText?.height || 792

        const canvas = document.createElement('canvas')
        canvas.width = pageWidth * pageScale * window.devicePixelRatio
        canvas.height = pageHeight * pageScale * window.devicePixelRatio
        canvas.style.width = `${pageWidth * pageScale}px`
        canvas.style.height = `${pageHeight * pageScale}px`

        const ctx = canvas.getContext('2d')
        if (ctx) {
          try {
            ctx.drawImage(activeDoc.image, 0, 0, canvas.width, canvas.height)

            if (!cancelledRef.current && pageViewRef.current) {
              if (canvasRef.current) {
                canvasRef.current.remove()
              }
              canvasRef.current = canvas
              canvas.style.display = 'block'
              pageViewRef.current.insertBefore(canvas, pageViewRef.current.firstChild)
            }
          } catch (e) {
            console.error('Image render error:', e)
          }
        }
      } else {
        // Sheet page rendering
        const activePageText = activeDoc.documentText.pages.find((p) => p.page === activePage)
        if (activePageText && activePageText.origin === 'sheet' && activePageText.grid) {
          const drawnWidth = sheetDrawnWidth(activePageText)
          const pageHeight = activePageText.height
          const grid = activePageText.grid

          const canvas = document.createElement('canvas')
          canvas.width = drawnWidth * pageScale * window.devicePixelRatio
          canvas.height = pageHeight * pageScale * window.devicePixelRatio
          canvas.style.width = `${drawnWidth * pageScale}px`
          canvas.style.height = `${pageHeight * pageScale}px`

          const ctx = canvas.getContext('2d')
          if (ctx) {
            ctx.scale(pageScale * window.devicePixelRatio, pageScale * window.devicePixelRatio)
            
            // Fill white
            ctx.fillStyle = 'white'
            ctx.fillRect(0, 0, drawnWidth, pageHeight)
            
            // Fill top 20 points with light gray
            ctx.fillStyle = '#f3f4f6'
            ctx.fillRect(0, 0, drawnWidth, 20)
            
            // Fill left 36 points with light gray
            ctx.fillRect(0, 0, 36, pageHeight)
            
            // Draw grid lines
            ctx.strokeStyle = '#d1d5db'
            ctx.lineWidth = 0.5
            
            // Vertical lines
            for (const col of grid.cols) {
              const x = col.x + col.w
              ctx.beginPath()
              ctx.moveTo(x, 0)
              ctx.lineTo(x, pageHeight)
              ctx.stroke()
            }
            
            // Horizontal lines
            for (const row of grid.rows) {
              const y = row.y + row.h
              ctx.beginPath()
              ctx.moveTo(0, y)
              ctx.lineTo(drawnWidth, y)
              ctx.stroke()
            }
            
            // Draw column letters
            ctx.fillStyle = '#6b7280'
            ctx.font = '9px sans-serif'
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            for (const col of grid.cols) {
              const x = col.x + col.w / 2
              ctx.fillText(col.label, x, 10)
            }
            
            // Draw row numbers
            ctx.textAlign = 'right'
            for (const row of grid.rows) {
              const y = row.y + row.h / 2
              ctx.fillText(row.label, 32, y)
            }
            
            // Draw cell text
            ctx.fillStyle = '#111827'
            ctx.font = `${Math.min(10, Math.max(6, pageHeight * 0.05))}px sans-serif`
            ctx.textAlign = 'left'
            ctx.textBaseline = 'middle'

            // A text runs on into the empty cells to its right, as in Excel; it stops at the next cell with text in its row
            const lastCol = grid.cols[grid.cols.length - 1]
            const gridRight = lastCol ? lastCol.x + lastCol.w : activePageText.width
            for (const item of activePageText.items) {
              const box = item.box
              const clipRight = activePageText.items
                .filter((o) => o !== item && Math.abs(o.box.y - box.y) < 0.01 && o.box.x > box.x)
                .reduce((m, o) => Math.min(m, o.box.x), gridRight)
              ctx.save()
              ctx.beginPath()
              // For items with no item to their right, clip at drawnWidth; otherwise use clipRight
              const hasItemToRight = activePageText.items.some(
                (o) => o !== item && Math.abs(o.box.y - box.y) < 0.01 && o.box.x > box.x
              )
              const finalClipRight = hasItemToRight ? clipRight : drawnWidth
              ctx.rect(box.x, box.y, Math.max(box.w, finalClipRight - box.x), box.h) // x, y, width, height
              ctx.clip()
              ctx.fillText(item.str, box.x + 3, box.y + box.h / 2)
              ctx.restore()
            }
            
            if (!cancelledRef.current && pageViewRef.current) {
              if (canvasRef.current) {
                canvasRef.current.remove()
              }
              canvasRef.current = canvas
              canvas.style.display = 'block'
              pageViewRef.current.insertBefore(canvas, pageViewRef.current.firstChild)
            }
          }
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
  }, [loadState, activeDocId, activePage, documents, pageScale])

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

  // Get readings for active document, active page only
  const activeReadings = verified.filter(
    (r): r is Extract<VerifiedReading, { status: 'accepted' }> => r.doc === activeDocId && r.page === activePage && r.status === 'accepted' && r.box !== null
  )
  const rejectedReadings = verified.filter((r): r is Extract<VerifiedReading, { status: 'rejected' | 'uncertain' }> => r.doc === activeDocId && r.page === activePage && (r.status === 'rejected' || r.status === 'uncertain'))

  // Get page dimensions for canvas
  const activeDoc = documents.find((d) => d.docId === activeDocId)
  const activePageText = activeDoc?.documentText.pages.find((p) => p.page === activePage) ?? activeDoc?.documentText.pages[0]
  const pageCount = activeDoc?.documentText.pages.length ?? 1
  const pageWidth = activePageText?.width || 612
  const pageHeight = activePageText?.height || 792

  return (
    <div data-testid="stitch-board" style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Top bar: what this screen is, the DRAFT notice, what it was checked against, the CSV hand-off */}
      <header data-testid="top-bar">
        <div className="board-heading">
          <div className="board-title-row">
            <h1 className="board-title">
              {APP_NAME && <span className="app-name">{APP_NAME}</span>}
              {BOARD_TITLE}
            </h1>
            <div data-testid="draft-notice">{draft?.notice || 'DRAFT, NOT FOR FILING'}</div>
          </div>
          <div className="board-meta">
            <span>Shipment: {activeBundle.title}</span>
            <span data-testid="hts-revision">
              Checked against {draft?.htsRevisionTitle || 'HTS Revision (loading)'}
            </span>
            <span data-testid="reader-mode">
              {upload
                ? upload.mode === 'fake'
                  ? 'Test mode: recorded answers, no AI call'
                  : 'Read by the AI reader (claude-haiku-5-5). Check every value.'
                : 'Pre-read sample: no AI call'}
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          {upload ? (
            <button
              data-testid="back-to-sample"
              className="btn"
              onClick={() => {
                setDocuments([])
                setLoadState('loading')
                setUpload(null)
                setShowUpload(false)
              }}
            >
              Back to sample
            </button>
          ) : (
            <button
              data-testid="open-upload"
              className="btn"
              onClick={() => setShowUpload(true)}
            >
              Upload documents
            </button>
          )}
          {csvUrl && (
            <a
              data-testid="download-csv"
              className="btn btn-primary"
              href={csvUrl}
              download={upload ? 'uploaded-7501-draft.csv' : `${activeBundle.bundle}-7501-draft.csv`}
            >
              Download CSV
            </a>
          )}
        </div>
      </header>

      {/* Legend: what the thread colours and the value outlines mean */}
      <Legend />

      {/* Main layout */}
      <div
        ref={containerRef}
        style={{
          display: 'flex',
          flex: 1,
          minHeight: 0,
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* Left pane - documents */}
        <div ref={documentsPaneRef} data-testid="documents-pane" style={{ display: 'flex', flexDirection: 'column', width: '45%' }}>
          {/* Upload panel */}
          {showUpload && (
            <UploadPanel
              onLoaded={(r) => {
                setDocuments([])
                setLoadState('loading')
                setUpload(r)
                setShowUpload(false)
              }}
              onClose={() => setShowUpload(false)}
            />
          )}

          {/* Document tabs */}
          <div data-testid="document-tabs">
            {activeBundle.documents.map((doc) => (
              <button
                key={doc.docId}
                data-testid={`tab-${doc.docId}`}
                role="tab"
                aria-selected={activeDocId === doc.docId}
                onClick={() => { setActiveDocId(doc.docId); setActivePage(1) }}
              >
                {doc.label}
              </button>
            ))}
          </div>

          {/* Page navigation */}
          {pageCount > 1 && (
            <div data-testid="page-nav" className="page-nav">
              <button data-testid="page-prev" type="button" disabled={activePage <= 1} onClick={() => setActivePage((p) => Math.max(1, p - 1))}>Previous page</button>
              <span data-testid="page-indicator">Page {activePage} of {pageCount}</span>
              <button data-testid="page-next" type="button" disabled={activePage >= pageCount} onClick={() => setActivePage((p) => Math.min(pageCount, p + 1))}>Next page</button>
            </div>
          )}

          {/* Approx note when active page is from image transcript */}
          {activePageText?.origin === 'imageTranscript' && (
            <div data-testid="approx-note" style={{
              padding: '0.5rem 1rem',
              margin: '1rem 1rem 0',
              fontSize: 'var(--fs-small)',
              background: '#fff9e6',
              border: '1px solid #fcd34d',
              borderRadius: '4px',
              color: '#78350f'
            }}>
              Boxes on a photo or scan are where the AI reader placed each line. They can be off; check the words.
            </div>
          )}

          {/* Page view */}
          <div
            data-testid="page-view"
            ref={pageViewRef}
            style={{
              flex: 1,
              minHeight: 0,
              position: 'relative',
              overflow: 'auto',
              background: '#fff',
              alignSelf: 'flex-start',
              margin: '1rem',
            }}
          >

            {/* Reading boxes overlaid on canvas */}
            {activeReadings.map((reading) => {
              const box = reading.box;
              if (!box) return null;
              const scale = pageScale
              const left = box.x * scale - 2
              const top = box.y * scale - 2
              const width = box.w * scale + 4
              const height = box.h * scale + 4

              return (
                <div
                  key={reading.field}
                  data-testid={`box-${reading.field}`}
                  data-reading={reading.field}
                  data-approx={reading.origin === 'imageTranscript' ? 'true' : undefined}
                  data-selected={selectedField && fieldMap.get(selectedField)?.sources.some(
                    (s) => s.kind === 'document' && s.doc === activeDocId && s.page === activePage && s.readingField === reading.field
                  ) ? 'true' : 'false'}
                  style={{
                    position: 'absolute',
                    left: `${left}px`,
                    top: `${top}px`,
                    width: `${width}px`,
                    height: `${height}px`,
                  }}
                >
                  {reading.origin === 'imageTranscript' && selectedField && fieldMap.get(selectedField)?.sources.some(
                    (s) => s.kind === 'document' && s.doc === activeDocId && s.page === activePage && s.readingField === reading.field
                  ) && (
                    <div data-testid="approx-label" data-label-side={approxLabelSide(left, width, pageWidth * pageScale)}>AI estimate</div>
                  )}
                </div>
              )
            })}

            {/* Uncertain reading boxes overlaid on canvas */}
            {rejectedReadings
              .filter((r): r is Extract<VerifiedReading, { status: 'uncertain' }> => r.status === 'uncertain' && r.box !== null)
              .map((reading) => {
                const box = reading.box;
                if (!box) return null;
                const scale = pageScale
                const left = box.x * scale - 2
                const top = box.y * scale - 2
                const width = box.w * scale + 4
                const height = box.h * scale + 4

                return (
                  <div
                    key={reading.field}
                    data-testid={`uncertain-box-${reading.field}`}
                    data-reading={reading.field}
                    data-approx={reading.origin === 'imageTranscript' ? 'true' : undefined}
                    data-selected={selectedField && fieldMap.get(selectedField)?.sources.some(
                      (s) => s.kind === 'document' && s.doc === activeDocId && s.page === activePage && s.readingField === reading.field
                    ) ? 'true' : 'false'}
                    style={{
                      position: 'absolute',
                      left: `${left}px`,
                      top: `${top}px`,
                      width: `${width}px`,
                      height: `${height}px`,
                    }}
                  >
                    {reading.origin === 'imageTranscript' && selectedField && fieldMap.get(selectedField)?.sources.some(
                      (s) => s.kind === 'document' && s.doc === activeDocId && s.page === activePage && s.readingField === reading.field
                    ) && (
                      <div data-testid="approx-label" data-label-side={approxLabelSide(left, width, pageWidth * pageScale)}>AI estimate</div>
                    )}
                  </div>
                )
              })}

            {/* Source boxes for document sources without reading boxes */}
            {draft && allFields(draft)
              .flatMap((field) =>
                field.sources
                  .filter((s): s is DocSource => s.kind === 'document' && s.box !== null)
                  .map((source) => ({ field, source }))
              )
              .filter((item) => item.source.doc === activeDocId && item.source.page === activePage)
              .filter((item) =>
                !activeReadings.some((r) => r.field === item.source.readingField) &&
                !rejectedReadings.some((r) => r.field === item.source.readingField)
              )
              .reduce((unique, item) => {
                if (!unique.some((u) => u.source.readingField === item.source.readingField)) {
                  unique.push(item);
                }
                return unique;
              }, [] as Array<{ field: DraftField; source: DocSource }>)
              .map((item) => {
                const box = item.source.box;
                if (!box) return null;
                const scale = pageScale
                const left = box.x * scale - 2
                const top = box.y * scale - 2
                const width = box.w * scale + 4
                const height = box.h * scale + 4

                return (
                  <div
                    key={`box-${item.source.readingField}`}
                    data-testid={`box-${item.source.readingField}`}
                    data-reading={item.source.readingField}
                    data-source-box="true"
                    data-selected={selectedField && fieldMap.get(selectedField)?.sources.some(
                      (s) => s.kind === 'document' && s.doc === activeDocId && s.page === activePage && s.readingField === item.source.readingField
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

          <div data-testid="reading-lists" style={{ flex: '0 1 auto', maxHeight: '30%', overflowY: 'auto', margin: '0 1rem' }}>
            {/* Uncertain readings */}
            <div data-testid="uncertain-readings">
              {rejectedReadings
                .filter((r): r is Extract<VerifiedReading, { status: 'uncertain' }> => r.status === 'uncertain')
                .map((reading) => (
                  <div key={reading.field} data-testid={`uncertain-reading-${reading.field}`} data-not-in-transcript={reading.notInTranscript ? "true" : undefined} style={{ padding: '0.5rem 0.5rem', marginBottom: '0.5rem', background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: '4px' }}>
                    <span className="field-name" style={{ color: '#92400e' }}>{reading.field}</span>
                    <span style={{ marginLeft: '0.5rem', color: '#78350f' }}>"{reading.value || ''}"</span>
                    <div style={{ marginTop: '0.25rem', fontSize: 'var(--fs-small)', color: '#78350f' }}>
                      {reading.notInTranscript ? 'not in the AI reader\'s transcript, so no box; a person finds it on the page and confirms it' : 'not sure, not used until a person checks it'}
                    </div>
                  </div>
                ))}
            </div>

            {/* Rejected readings */}
            <div data-testid="rejected-readings">
              {rejectedReadings
                .filter((r): r is Extract<VerifiedReading, { status: 'rejected' }> => r.status === 'rejected')
                .map((reading) => (
                <div key={reading.field}>
                  <span className="field-name">{reading.field}</span>
                  <span className="rejected-tag">rejected, not used in the draft</span>
                  <span className="reason">{'message' in reading ? reading.message : ''}</span>
                </div>
              ))}
            </div>
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
                <div className="review-head">
                  <h3 className="section-title">
                    Needs review{' '}
                    <span data-testid="needs-review-count" className="count-pill">{draft.needsReview.length}</span>
                  </h3>
                  <span className="review-sub">person fills {draft.personInput.length}</span>
                  {!upload && (
                    <>
                      {overrides.length === 0 ? (
                        <button
                          data-testid="apply-demo-answers"
                          className="btn btn-small"
                          onClick={() => setOverrides(overridesList)}
                        >
                          Use test answers for this demo
                        </button>
                      ) : (
                        <button
                          data-testid="reset-answers"
                          className="btn btn-small btn-danger"
                          onClick={() => setOverrides([])}
                        >
                          Clear person answers ({overrides.length})
                        </button>
                      )}
                    </>
                  )}
                </div>
                {draft.needsReview.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {draft.needsReview.map((item) => (
                      <button
                        key={item.fieldId}
                        data-testid={`review-${item.fieldId}`}
                        className={selectedField === item.fieldId ? 'review-item is-selected' : 'review-item'}
                        onClick={() => setSelectedField(item.fieldId)}
                      >
                        <div className="review-item-title">{fieldTitle(fieldMap.get(item.fieldId), item.label)}</div>
                        <div className="review-item-reason">{tidyText(item.reason)}</div>
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
                <h3 className="section-title">Line items</h3>
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
                            <div className="cell-tag">inv {line.invoiceLines.join('+')}</div>
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
                                        <div className="cell-tag">Ch. 99</div>
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
                <h3 className="section-title">Totals</h3>
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
          {threads.map((thread, idx) => {
            const color = thread.kind === 'doc' ? THREAD_DOC_COLOR : THREAD_CALC_COLOR
            return (
              <g key={idx}>
                {/* Cross stitches along the thread */}
                <path
                  d={thread.d}
                  fill="none"
                  stroke={color}
                  strokeWidth={STITCH.width}
                  strokeDasharray={STITCH.dash}
                  opacity={STITCH.opacity}
                />
                <path
                  data-testid={thread.kind === 'doc' ? 'thread-doc' : 'thread-calc'}
                  d={thread.d}
                  fill="none"
                  stroke={color}
                  strokeWidth={1.75}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </g>
            )
          })}
        </svg>
      </div>

      {/* Source Strip */}
      <SourceStrip 
        selectedField={selectedField} 
        fieldMap={fieldMap} 
        draft={draft}
        documents={activeBundle.documents}
        verified={verified}
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
 * Legend: one row under the top bar that says what the thread colours and the value outlines mean.
 * The swatches reuse the thread colours, the stitch pattern and the value outlines.
 */
function Legend() {
  return (
    <div data-testid="legend" className="legend">
      <span className="legend-group">Threads</span>
      <span className="legend-item">
        <ThreadSwatch color={THREAD_DOC_COLOR} />
        read from a document line
      </span>
      <span className="legend-item">
        <ThreadSwatch color={THREAD_CALC_COLOR} />
        computed from other values
      </span>
      <span className="legend-group">Values</span>
      <span className="legend-item">
        <span className="swatch swatch-copied" />
        copied
      </span>
      <span className="legend-item">
        <span className="swatch swatch-computed" />
        computed
      </span>
      <span className="legend-item">
        <span className="swatch swatch-needsReview" />
        needs review
      </span>
      <span className="legend-item">
        <span className="swatch swatch-personInput" />
        a person fills
      </span>
      <span className="legend-item">
        <span className="swatch swatch-personEdited" />
        entered by a person
      </span>
    </div>
  )
}

/** A short piece of thread with its cross stitches, drawn like the threads on the board. */
function ThreadSwatch({ color }: { color: string }) {
  return (
    <svg className="thread-swatch" width="28" height="10" viewBox="0 0 28 10" aria-hidden="true">
      <path d="M 2 5 H 26" fill="none" stroke={color} strokeWidth={STITCH.width} strokeDasharray={STITCH.dash} opacity={STITCH.opacity} />
      <path d="M 2 5 H 26" fill="none" stroke={color} strokeWidth={1.75} strokeLinecap="round" />
    </svg>
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

/** True when the element takes up space on screen (false inside a closed <details>). */
function isRendered(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect()
  return r.width > 0 || r.height > 0
}

/**
 * SVG path through the points of a route made of straight segments, with each corner rounded
 * by a quadratic curve of radius r (smaller when a segment is short). Repeated points are skipped.
 */
function roundedPath(points: Array<[number, number]>, r = 6): string {
  const pts = points.filter(
    (p, i) => i === 0 || Math.abs(p[0] - points[i - 1][0]) > 0.5 || Math.abs(p[1] - points[i - 1][1]) > 0.5
  )
  let d = `M ${pts[0][0]} ${pts[0][1]}`
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1]
    const [x, y] = pts[i]
    const [nx, ny] = pts[i + 1]
    const inLen = Math.hypot(x - px, y - py)
    const outLen = Math.hypot(nx - x, ny - y)
    const k = Math.min(r, inLen / 2, outLen / 2)
    d += ` L ${x - ((x - px) / inLen) * k} ${y - ((y - py) / inLen) * k}`
    d += ` Q ${x} ${y} ${x + ((nx - x) / outLen) * k} ${y + ((ny - y) / outLen) * k}`
  }
  if (pts.length > 1) {
    const last = pts[pts.length - 1]
    d += ` L ${last[0]} ${last[1]}`
  }
  return d
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
    fontSize: compact ? 'var(--fs-dense)' : 'var(--fs-small)',
    fontVariantNumeric: 'tabular-nums',
    textAlign: 'left' as const,
    ...statusStyles[field.status],
    ...(selected && { boxShadow: '0 0 0 2px #fff, 0 0 0 4px #1e3a8a' }),
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
  verified,
  onApply,
  onUndo,
  onSelect,
}: {
  selectedField: string | null
  fieldMap: Map<string, DraftField>
  draft: Draft | null
  documents: Array<{ docId: string; label: string }>
  verified: VerifiedReading[]
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
        minHeight: field ? '9rem' : undefined,
        background: '#fff',
        borderTop: '1px solid #ddd',
        padding: '0.75rem 1rem',
        fontSize: 'var(--fs-small)',
        maxHeight: '12rem',
        overflowY: 'auto',
        lineHeight: 1.4,
      }}
    >
      {!field ? (
        <div style={{ color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
          Click any value in the draft to see where it came from: the document line, the tariff row, or the values it was computed from.
        </div>
      ) : (
        <>
          {/* Header: Block and label */}
          <div style={{ marginBottom: '0.5rem', fontWeight: 600, fontSize: 'var(--fs-body)', color: 'var(--ink)' }}>
            {fieldTitle(field, field.label)}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', columnGap: '1.5rem', alignItems: 'start' }}>
            <div>
              {/* Status, with the value form or the Undo button on the same row */}
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: '0.75rem', rowGap: '0.25rem', marginBottom: '0.5rem' }}>
                <span data-testid="strip-status" style={{ color: 'var(--muted)', fontWeight: 500 }}>{statusWords[field.status]}</span>

              {field.status === 'needsReview' && field.value && (isImageReviewReason(field.reason) || field.reason === LOW_CONFIDENCE_REVIEW_REASON) && (
                <button
                  type="button"
                  data-testid="confirm-image-value"
                  className="btn btn-small"
                  onClick={() => onApply(field.id, field.value as string)}
                >
                  Confirm this value
                </button>
              )}

              {/* Candidate buttons for needsReview with candidates */}
              {field.status === 'needsReview' && field.candidates && field.candidates.length > 0 && (
                <div data-testid="candidates" style={{ display: 'flex', flexWrap: 'wrap', columnGap: '0.5rem', rowGap: '0.25rem', marginBottom: '0.5rem' }}>
                  {field.candidates.map((c) => (
                    <button
                      key={c.value}
                      type="button"
                      className="btn btn-small"
                      data-testid={`candidate-${c.value}`}
                      onClick={() => onApply(field.id, c.value)}
                    >
                      Use {c.label}
                    </button>
                  ))}
                </div>
              )}

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
                    className="text-input"
                  />
                  <button
                    type="submit"
                    data-testid="override-apply"
                    className="btn btn-small"
                  >
                    Use this value
                  </button>
                </form>
              )}

              {/* Undo button for personEdited or confirmed */}
              {(field.status === 'personEdited' || field.note === CONFIRMED_NOTE) && (
                <button
                  data-testid="override-undo"
                  onClick={() => onUndo(field.id)}
                  className="btn btn-small"
                >
                  Undo
                </button>
              )}
              </div>

              {/* Reason */}
              {field.reason && (
                <div style={{ marginBottom: '0.5rem', color: '#b91c1c' }} data-testid="strip-reason">
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
                <div style={{ marginBottom: '0.5rem', color: 'var(--muted)' }}>
                  Rule: <em>{field.rule}</em>
                </div>
              )}

              {/* Note */}
              {field.note && (
                <div style={{ marginBottom: '0.5rem', color: 'var(--muted)' }}>
                  Note: {tidyText(field.note)}
                </div>
              )}
            </div>
            <div>
              {/* Sources */}
              {field.sources.length > 0 && (
                <div style={{ marginBottom: '0.5rem' }}>
                  {field.sources.map((source, idx) => {
                    // Find lineText for image transcript sources
                    let lineText = ''
                    if (source.kind === 'document' && source.origin === 'imageTranscript' && source.readingField) {
                      const reading = verified.find(
                        (r) => r.field === source.readingField && r.doc === source.doc && r.page === source.page
                      )
                      lineText = (reading as any)?.lineText || ''
                    }

                    return (
                      <div
                        key={idx}
                        data-testid="strip-source"
                        style={{
                          marginBottom: '0.25rem',
                          paddingLeft: '0.5rem',
                          borderLeft: `3px solid ${source.kind === 'document' ? THREAD_DOC_COLOR : '#9ca3af'}`,
                          color: 'var(--ink)',
                        }}
                      >
                        {source.kind === 'document' ? (
                          <>
                            {`${docMap.get(source.doc) || source.doc} p.${source.page}: "${source.quote}"${source.cell ? ` (cell ${source.cell})` : ''}`}
                            {source.origin === 'imageTranscript' && (
                              source.notInTranscript ? (
                                <> (read from an image by the AI reader) Not in its transcript, so there is no box on the page.</>
                              ) : (
                                <> (read from an image by the AI reader){lineText && <> Place estimated by the AI reader. Its transcript line: "{lineText}"</>}</>
                              )
                            )}
                          </>
                        ) : source.kind === 'codeTable' ? (
                          `${source.table} (${source.edition}): ${source.code} ${source.name}${source.country ? `, ${source.country}` : ''}`
                        ) : (
                          `Tariff schedule ${source.revision}, row ${source.htsno}`
                        )}
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Input links */}
              {field.inputs.length > 0 && (
                <div className="input-links">
                  <span className="input-links-label">Inputs:</span>
                  {field.inputs.map((id) => (
                    <button key={id} className="link-btn" onClick={() => onSelect(id)}>
                      {[id, fieldMap.get(id)?.label].filter(Boolean).join(' ')}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
