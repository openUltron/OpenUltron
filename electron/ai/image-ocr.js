const { execFile, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const util = require('util')

const execFileAsync = util.promisify(execFile)

function commandExists(cmd) {
  try {
    const out = spawnSync('which', [cmd], { encoding: 'utf8' })
    return out.status === 0 && !!String(out.stdout || '').trim()
  } catch {
    return false
  }
}

async function runTesseractOcr(imagePath) {
  if (!commandExists('tesseract')) return { ok: false, reason: 'tesseract-not-found', text: '' }
  try {
    const { stdout } = await execFileAsync('tesseract', [
      imagePath,
      'stdout',
      '-l',
      'chi_sim+eng',
      '--psm',
      '6'
    ], {
      timeout: 15000,
      maxBuffer: 10 * 1024 * 1024
    })
    const text = String(stdout || '').trim()
    if (!text) return { ok: false, reason: 'tesseract-empty', text: '' }
    return { ok: true, engine: 'tesseract', text }
  } catch (e) {
    return { ok: false, reason: e.message || 'tesseract-failed', text: '' }
  }
}

async function runMacVisionOcr(imagePath) {
  if (process.platform !== 'darwin') return { ok: false, reason: 'not-macos', text: '' }
  if (!commandExists('swift')) return { ok: false, reason: 'swift-not-found', text: '' }

  const swiftCode = `
import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
if args.count < 2 {
  fputs("missing-image-path\\n", stderr)
  exit(2)
}

let imagePath = args[1]
let imageUrl = URL(fileURLWithPath: imagePath)

guard let nsImage = NSImage(contentsOf: imageUrl) else {
  fputs("cannot-open-image\\n", stderr)
  exit(3)
}
var rect = NSRect(origin: .zero, size: nsImage.size)
guard let cgImage = nsImage.cgImage(forProposedRect: &rect, context: nil, hints: nil) else {
  fputs("cannot-convert-cgimage\\n", stderr)
  exit(4)
}

let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.usesLanguageCorrection = true
req.recognitionLanguages = ["zh-Hans", "en-US"]

do {
  let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
  try handler.perform([req])
  let obs = req.results ?? []
  let lines = obs.compactMap { $0.topCandidates(1).first?.string }
  print(lines.joined(separator: "\\n"))
} catch {
  fputs("vision-failed: \\(error)\\n", stderr)
  exit(5)
}
`

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ou-ocr-'))
  const scriptPath = path.join(tempDir, 'ocr.swift')
  try {
    fs.writeFileSync(scriptPath, swiftCode, 'utf8')
    const { stdout } = await execFileAsync('swift', [scriptPath, imagePath], {
      timeout: 20000,
      maxBuffer: 10 * 1024 * 1024
    })
    const text = String(stdout || '').trim()
    if (!text) return { ok: false, reason: 'vision-empty', text: '' }
    return { ok: true, engine: 'macos-vision', text }
  } catch (e) {
    return { ok: false, reason: e.message || 'vision-failed', text: '' }
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch {}
  }
}

async function runImageOcr(imagePath) {
  if (!imagePath || !fs.existsSync(imagePath)) return { ok: false, reason: 'image-not-found', text: '' }

  const vision = await runMacVisionOcr(imagePath)
  if (vision.ok) return vision

  const tess = await runTesseractOcr(imagePath)
  if (tess.ok) return tess

  return { ok: false, reason: `${vision.reason || 'vision-unavailable'}; ${tess.reason || 'tesseract-unavailable'}`, text: '' }
}

module.exports = {
  runImageOcr
}

