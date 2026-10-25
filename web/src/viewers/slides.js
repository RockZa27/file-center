/**
 * PowerPoint (.pptx) for the preview: every slide drawn read-only by @aiden0z/pptx-renderer (HTML/SVG, fitted to
 * the width), mounted while it scrolls into view. Zip limits on, no PDF.js worker, each slide cleaned (DOMPurify) after it is drawn.
 */
import { PptxViewer, RECOMMENDED_ZIP_LIMITS } from '@aiden0z/pptx-renderer'
import { cleanSlide } from './safe-html'

/** answers a function that frees the viewer */
export async function renderSlides(data, container, scrollContainer) {
  const viewer = await PptxViewer.open(data, container, {
    zipLimits: RECOMMENDED_ZIP_LIMITS,
    pdfjs: false,
    fitMode: 'contain',
    scrollContainer,
    lazyMedia: true,
    lazySlides: true,
    listOptions: { windowed: true, initialSlides: 3, batchSize: 3 },
    onSlideRendered: (_, el) => cleanSlide(el),
  })
  // a whole slide fits on the screen: no wider than the visible height allows (the viewer re-fits on resize)
  if (viewer.slideWidth && viewer.slideHeight) container.style.maxWidth = `calc(64vh * ${(viewer.slideWidth / viewer.slideHeight).toFixed(4)})`
  return { count: viewer.slideCount, destroy: () => viewer.destroy() }
}
