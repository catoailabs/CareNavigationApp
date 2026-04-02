/**
 * Build Workbench Page - Premium Three.js Ambient Lighting
 * 
 * Features:
 * - Three.js ambient scene matching VoiceAgentVisualizer lighting exactly
 * - ambientLight 0.5, pointLight #2D3B87 at [10,10,10], pointLight #FFFFFF at [-10,-10,-10]
 * - Environment preset="night"
 * - Glassmorphic icosahedron orb with gentle breathing + rotation
 * - Drifting particle field for depth
 * - Color System: surface-950 (#050505), surface-900 (#0A0A0A), ink-inverse
 * - Dark Rich Purple accents (#3730A3, #4C1D95)
 * - Glassmorphism: backdrop-blur-xl, bg-surface-900/60
 * - Preview Panel auto-opens on dev server detection
 */

import { useEffect, useState, useRef, useMemo, memo, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Canvas, useFrame } from '@react-three/fiber'
import { Environment } from '@react-three/drei'
import * as THREE from 'three'
import { useBuildStore } from '@/stores/buildStore'
import { LeftRail } from './LeftRail'
import { CenterPane } from './CenterPane'
import { cn } from '@/utils/cn'
import { 
  XMarkIcon,
  Squares2X2Icon,
  PlayIcon,
  StopIcon,
} from '@heroicons/react/24/outline'

const EASE = [0.16, 1, 0.3, 1] as const

// Dark rich purple colors
const PURPLE = {
  deep: '#3730A3',      // Indigo-800
  rich: '#4C1D95',      // Purple-900
  vibrant: '#6366F1',   // Indigo-500
  muted: '#818CF8',     // Indigo-400
  glow: 'rgba(76, 29, 149, 0.5)',
}

// ─────────────────────────────────────────────────────────────────────────────
// Three.js Ambient Scene - Exact lighting from VoiceAgentVisualizer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ambient glassmorphic orb — no audio reactivity, just gentle breathing + rotation
 */
function AmbientOrb() {
  const meshRef = useRef<THREE.Mesh>(null)
  const materialRef = useRef<THREE.ShaderMaterial>(null)

  const shader = useMemo(
    () => ({
      uniforms: {
        time: { value: 0 },
        color: { value: new THREE.Color('#2D3B87') },
        opacity: { value: 0.35 },
      },
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 vPosition;
        uniform float time;

        vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
        vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
        vec4 permute(vec4 x) { return mod289(((x*34.0)+1.0)*x); }
        vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

        float snoise(vec3 v) {
          const vec2 C = vec2(1.0/6.0, 1.0/3.0);
          const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
          vec3 i  = floor(v + dot(v, C.yyy));
          vec3 x0 = v - i + dot(i, C.xxx);
          vec3 g = step(x0.yzx, x0.xyz);
          vec3 l = 1.0 - g;
          vec3 i1 = min(g.xyz, l.zxy);
          vec3 i2 = max(g.xyz, l.zxy);
          vec3 x1 = x0 - i1 + C.xxx;
          vec3 x2 = x0 - i2 + C.yyy;
          vec3 x3 = x0 - D.yyy;
          i = mod289(i);
          vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
            + i.y + vec4(0.0, i1.y, i2.y, 1.0))
            + i.x + vec4(0.0, i1.x, i2.x, 1.0));
          float n_ = 0.142857142857;
          vec3 ns = n_ * D.wyz - D.xzx;
          vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
          vec4 x_ = floor(j * ns.z);
          vec4 y_ = floor(j - 7.0 * x_);
          vec4 x = x_ *ns.x + ns.yyyy;
          vec4 y = y_ *ns.x + ns.yyyy;
          vec4 h = 1.0 - abs(x) - abs(y);
          vec4 b0 = vec4(x.xy, y.xy);
          vec4 b1 = vec4(x.zw, y.zw);
          vec4 s0 = floor(b0)*2.0 + 1.0;
          vec4 s1 = floor(b1)*2.0 + 1.0;
          vec4 sh = -step(h, vec4(0.0));
          vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
          vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
          vec3 p0 = vec3(a0.xy, h.x);
          vec3 p1 = vec3(a0.zw, h.y);
          vec3 p2 = vec3(a1.xy, h.z);
          vec3 p3 = vec3(a1.zw, h.w);
          vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
          p0 *= norm.x;
          p1 *= norm.y;
          p2 *= norm.z;
          p3 *= norm.w;
          vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
          m = m * m;
          return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
        }

        void main() {
          vNormal = normalize(normalMatrix * normal);
          vPosition = position;
          float noise = snoise(position * 0.5 + time * 0.15);
          float displacement = noise * 0.08;
          vec3 newPosition = position + normal * displacement;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(newPosition, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 color;
        uniform float opacity;
        uniform float time;
        varying vec3 vNormal;
        varying vec3 vPosition;

        void main() {
          vec3 viewDirection = normalize(cameraPosition - vPosition);
          float fresnel = pow(1.0 - abs(dot(viewDirection, vNormal)), 3.0);
          float iridescence = sin(vPosition.x * 2.0 + time) * 0.5 + 0.5;
          vec3 finalColor = mix(color, vec3(1.0), iridescence * 0.15);
          finalColor = mix(finalColor, vec3(1.0), fresnel * 0.25);
          float finalOpacity = opacity + fresnel * 0.2;
          gl_FragColor = vec4(finalColor, finalOpacity);
        }
      `,
    }),
    []
  )

  useFrame((state) => {
    if (meshRef.current && materialRef.current) {
      const time = state.clock.getElapsedTime()
      materialRef.current.uniforms.time.value = time
      // Gentle breathing scale
      const scale = 1 + Math.sin(time * 0.4) * 0.03
      meshRef.current.scale.set(scale, scale, scale)
      // Slow rotation
      meshRef.current.rotation.y = time * 0.06
      meshRef.current.rotation.x = Math.sin(time * 0.03) * 0.1
    }
  })

  return (
    <mesh ref={meshRef}>
      <icosahedronGeometry args={[2, 4]} />
      <shaderMaterial
        ref={materialRef}
        args={[shader]}
        transparent
        side={THREE.DoubleSide}
      />
    </mesh>
  )
}

/**
 * Drifting particle field — no audio, just gentle orbital drift
 */
function AmbientParticles() {
  const particlesRef = useRef<THREE.Points>(null)
  const particleCount = 1200

  const [positions, colors] = useMemo(() => {
    const positions = new Float32Array(particleCount * 3)
    const colors = new Float32Array(particleCount * 3)
    const royalBlue = new THREE.Color('#2D3B87')

    for (let i = 0; i < particleCount; i++) {
      const radius = 5 + Math.random() * 6
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(Math.random() * 2 - 1)

      positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta)
      positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta)
      positions[i * 3 + 2] = radius * Math.cos(phi)

      const colorVariation = new THREE.Color().lerpColors(
        royalBlue,
        new THREE.Color('#FFFFFF'),
        Math.random() * 0.4
      )
      colors[i * 3] = colorVariation.r
      colors[i * 3 + 1] = colorVariation.g
      colors[i * 3 + 2] = colorVariation.b
    }

    return [positions, colors]
  }, [])

  useFrame((state) => {
    if (particlesRef.current) {
      const time = state.clock.getElapsedTime()
      particlesRef.current.rotation.y = time * 0.02
      particlesRef.current.rotation.x = Math.sin(time * 0.01) * 0.05
    }
  })

  return (
    <points ref={particlesRef}>
      <bufferGeometry>
        <bufferAttribute
          args={[positions, 3]}
          attach="attributes-position"
          count={particleCount}
        />
        <bufferAttribute
          args={[colors, 3]}
          attach="attributes-color"
          count={particleCount}
        />
      </bufferGeometry>
      <pointsMaterial
        size={0.04}
        vertexColors
        transparent
        opacity={0.45}
        blending={THREE.AdditiveBlending}
        sizeAttenuation
      />
    </points>
  )
}

/**
 * Scene — exact lighting from VoiceAgentVisualizer
 */
function BuildScene() {
  return (
    <>
      <color attach="background" args={['#050505']} />
      <ambientLight intensity={0.5} />
      <pointLight position={[10, 10, 10]} intensity={1} color="#2D3B87" />
      <pointLight position={[-10, -10, -10]} intensity={0.5} color="#FFFFFF" />

      <AmbientOrb />
      <AmbientParticles />

      <Environment preset="night" />
    </>
  )
}

/**
 * Full-screen decorative Canvas — sits behind all UI
 */
const BuildAmbientScene = memo(function BuildAmbientScene() {
  return (
    <div className="absolute inset-0 pointer-events-none z-0">
      <Canvas
        camera={{ position: [0, 0, 10], fov: 75 }}
        gl={{ antialias: true, alpha: false }}
        style={{ width: '100%', height: '100%' }}
      >
        <BuildScene />
      </Canvas>
    </div>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// Icons
// ─────────────────────────────────────────────────────────────────────────────

function SidebarLeftIcon({ className }: { className?: string }) {
  return (
    <svg className={cn("w-5 h-5", className)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Header Component
// ─────────────────────────────────────────────────────────────────────────────

interface HeaderProps {
  leftOpen: boolean
  previewOpen: boolean
  isPreviewRunning: boolean
  onToggleLeft: () => void
  onTogglePreview: () => void
  onStopPreview: () => void
}

const Header = memo(function Header({
  leftOpen,
  previewOpen,
  isPreviewRunning,
  onToggleLeft,
  onTogglePreview,
  onStopPreview,
}: HeaderProps) {
  return (
    <header className="relative z-20 flex-shrink-0 h-14 px-4 flex items-center justify-between border-b border-surface-800 bg-surface-900/90 backdrop-blur">
      {/* Left Section */}
      <div className="flex items-center gap-4">
        {/* Logo */}
        <div className="relative group">
          <div 
            className="absolute -inset-2 rounded-xl blur-lg opacity-0 group-hover:opacity-100 transition-opacity duration-500"
            style={{ background: `linear-gradient(90deg, ${PURPLE.deep}40, ${PURPLE.rich}40)` }}
          />
          <img src="/Logo.png" alt="Ron" className="relative h-7 w-auto" />
        </div>
        
        {/* Divider */}
        <div className="h-5 w-px bg-surface-800" />
        
        {/* Left rail toggle */}
        <button 
          onClick={onToggleLeft}
          className={cn(
            "p-2 rounded-lg transition-all duration-200 group",
            leftOpen 
              ? "text-ink-inverse bg-surface-800" 
              : "text-ink-inverse-muted hover:text-ink-inverse hover:bg-surface-800/50"
          )}
          title="Toggle Chats"
        >
          <SidebarLeftIcon className="group-hover:scale-105 transition-transform" />
        </button>
      </div>

      {/* Center - Build Mode Indicator */}
      <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-2">
        <div 
          className="flex items-center gap-2 px-4 py-1.5 rounded-full border"
          style={{
            background: 'rgba(76, 29, 149, 0.1)',
            borderColor: 'rgba(76, 29, 149, 0.3)'
          }}
        >
          <div className="relative">
            <div className="w-2 h-2 rounded-full bg-[#6366F1]" />
            <div className="absolute inset-0 w-2 h-2 rounded-full bg-[#6366F1] animate-ping opacity-30" />
          </div>
          <span className="text-xs font-medium tracking-wide text-ink-inverse-secondary uppercase">Build Mode</span>
        </div>
      </div>

      {/* Right Section */}
      <div className="flex items-center gap-3">
        {/* Preview Toggle */}
        {isPreviewRunning ? (
          <div className="flex items-center gap-2">
            <button
              onClick={onTogglePreview}
              className={cn(
                "relative flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all duration-300 overflow-hidden",
                previewOpen
                  ? "text-white shadow-lg"
                  : "text-ink-inverse-secondary hover:text-ink-inverse border border-surface-700"
              )}
              style={{
                background: previewOpen 
                  ? `linear-gradient(135deg, ${PURPLE.deep}, ${PURPLE.rich})`
                  : 'rgba(10, 10, 10, 0.6)',
                boxShadow: previewOpen ? `0 4px 20px ${PURPLE.glow}` : undefined
              }}
            >
              <div className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
              </div>
              <Squares2X2Icon className="w-4 h-4" />
              <span>Preview</span>
            </button>
            <button
              onClick={onStopPreview}
              className="p-2 rounded-xl bg-surface-800 text-ink-inverse-muted hover:text-red-400 hover:bg-red-500/10 border border-surface-700 transition-colors"
              title="Stop preview server"
            >
              <StopIcon className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <button
            disabled
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-surface-800/50 text-ink-inverse-muted border border-surface-800 cursor-not-allowed"
          >
            <Squares2X2Icon className="w-4 h-4" />
            <span>Preview</span>
          </button>
        )}
      </div>
    </header>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// Preview Panel - Browser preview for running dev server
// ─────────────────────────────────────────────────────────────────────────────

interface PreviewPanelProps {
  url: string
  onClose: () => void
}

const PreviewPanel = memo(function PreviewPanel({ url, onClose }: PreviewPanelProps) {
  return (
    <motion.div
      initial={{ x: "100%", opacity: 0.5 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: "100%", opacity: 0 }}
      transition={{ duration: 0.35, ease: EASE }}
      className="absolute inset-0 z-30 bg-surface-950 border-l border-surface-800 shadow-2xl shadow-black/50 flex flex-col"
    >
      {/* Preview Header */}
      <div className="flex-none flex items-center justify-between px-4 py-3 border-b border-surface-800 bg-surface-900/60 backdrop-blur">
        <div className="flex items-center gap-3">
          <div 
            className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ background: 'rgba(76, 29, 149, 0.2)' }}
          >
            <PlayIcon className="w-4 h-4 text-[#6366F1]" />
          </div>
          <div>
            <h3 className="text-sm font-medium text-ink-inverse">Live Preview</h3>
            <p className="text-xs text-ink-inverse-muted font-mono">{url}</p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-2 rounded-lg hover:bg-surface-800 text-ink-inverse-muted hover:text-ink-inverse transition-colors"
          aria-label="Close preview"
        >
          <XMarkIcon className="w-5 h-5" />
        </button>
      </div>

      {/* Browser Frame */}
      <div className="flex-1 bg-white">
        <iframe
          src={url}
          className="w-full h-full border-0"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          allow="accelerometer; camera; encrypted-media; geolocation; gyroscope; microphone; midi"
        />
      </div>
    </motion.div>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// Dev Server Detection Hook
// ─────────────────────────────────────────────────────────────────────────────

const DEV_SERVER_PATTERNS = [
  /npm run dev/i,
  /npm start/i,
  /pnpm dev/i,
  /pnpm start/i,
  /yarn dev/i,
  /yarn start/i,
  /vite/i,
  /next dev/i,
  /nuxt dev/i,
  /astro dev/i,
  /remix dev/i,
  /gatsby develop/i,
  /parcel serve/i,
  /webpack serve/i,
  /http-server/i,
  /live-server/i,
  /python -m http\.server/i,
  /python3 -m http\.server/i,
]

const DEV_SERVER_URL_PATTERNS = [
  /localhost:\d+/i,
  /127\.0\.0\.1:\d+/i,
  /0\.0\.0\.0:\d+/i,
  /:\d{4,5}/i,
]

function useDevServerDetection() {
  const [isRunning, setIsRunning] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const { activeMessages } = useBuildStore()
  const messages = activeMessages()

  // Check for dev server commands in messages
  useEffect(() => {
    const checkForDevCommands = () => {
      for (const message of messages) {
        if (message.role !== 'assistant') continue
        
        for (const block of message.blocks) {
          // Check code blocks for dev commands
          if (block.type === 'code') {
            const content = block.content || ''
            for (const pattern of DEV_SERVER_PATTERNS) {
              if (pattern.test(content)) {
                // Look for URL patterns
                for (const urlPattern of DEV_SERVER_URL_PATTERNS) {
                  const match = content.match(urlPattern)
                  if (match) {
                    const url = match[0].startsWith('http') ? match[0] : `http://${match[0]}`
                    setPreviewUrl(url)
                    setIsRunning(true)
                    return
                  }
                }
                // Default to common dev server ports
                setPreviewUrl('http://localhost:3000')
                setIsRunning(true)
                return
              }
            }
          }
          
          // Check text blocks for URLs
          if (block.type === 'text') {
            const content = block.content || ''
            const urlMatch = content.match(/(https?:\/\/localhost:\d+|https?:\/\/127\.0\.0\.1:\d+)/i)
            if (urlMatch) {
              setPreviewUrl(urlMatch[1])
              setIsRunning(true)
              return
            }
          }
        }
      }
    }

    checkForDevCommands()
  }, [messages])

  const stopPreview = useCallback(() => {
    setIsRunning(false)
    setPreviewUrl(null)
  }, [])

  return { isRunning, previewUrl, stopPreview }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Page Component
// ─────────────────────────────────────────────────────────────────────────────

export function BuildWorkbenchPage() {
  const { incrementNavigation, ensureActiveSession } = useBuildStore()
  const [leftOpen, setLeftOpen] = useState(true)
  const [previewOpen, setPreviewOpen] = useState(false)
  
  // Dev server detection
  const { isRunning: isPreviewRunning, previewUrl, stopPreview } = useDevServerDetection()

  // Auto-open preview when dev server is detected
  useEffect(() => {
    if (isPreviewRunning && previewUrl) {
      setPreviewOpen(true)
    }
  }, [isPreviewRunning, previewUrl])


  // Increment navigation counter on mount
  useEffect(() => {
    incrementNavigation()
  }, [incrementNavigation])

  // Ensure an active chat session exists
  useEffect(() => {
    ensureActiveSession()
  }, [ensureActiveSession])

  return (
    <div className="h-full flex flex-col relative overflow-hidden bg-surface-950">
      {/* Three.js Ambient Lighting Scene */}
      <BuildAmbientScene />
      
      {/* Header / Toolbar */}
      <Header
        leftOpen={leftOpen}
        previewOpen={previewOpen}
        isPreviewRunning={isPreviewRunning}
        onToggleLeft={() => setLeftOpen(!leftOpen)}
        onTogglePreview={() => setPreviewOpen(!previewOpen)}
        onStopPreview={stopPreview}
      />

      {/* Main Content Layout */}
      <div className="relative z-10 flex-1 flex min-h-0">
        
        {/* Left Rail (Collapsible) - Chats & Projects Only */}
        <AnimatePresence initial={false}>
          {leftOpen && (
            <motion.div
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 280, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.3, ease: EASE }}
              className="flex-shrink-0 border-r border-surface-800 bg-surface-900/60 backdrop-blur-xl overflow-hidden"
            >
              <div className="w-[280px] h-full">
                <LeftRail />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Center Pane (Chat) */}
        <div className="flex-1 flex min-w-0 relative">
          <CenterPane />

          {/* Sliding Preview Panel - Auto-opens on dev commands */}
          <AnimatePresence>
            {previewOpen && isPreviewRunning && previewUrl && (
              <PreviewPanel 
                url={previewUrl}
                onClose={() => setPreviewOpen(false)}
              />
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}
