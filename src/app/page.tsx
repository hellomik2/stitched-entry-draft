import StitchBoard, { type BundleJson } from './StitchBoard'

// Import data
import bundleJson from '../../samples/lantern-hollow/bundle.json'
import readingJson from '../../samples/lantern-hollow/reading.json'
import overridesJson from '../../samples/lantern-hollow/overrides-demo.json'
import htsJson from '../../data/hts/2026HTSRev23-subset.json'

export default function Home() {
  return (
    <StitchBoard
      bundle={bundleJson as BundleJson}
      reading={readingJson}
      overrides={overridesJson}
      hts={htsJson}
    />
  )
}
