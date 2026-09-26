/**
 * Repo facts for the Node profile (design §4): versions, module system,
 * frameworks detected and, just as important, frameworks not detected, so
 * the model is told what the repository is not.
 */
export interface NodeRepoFacts {
  nodeVersion: string | null
  typescriptVersion: string | null
  moduleSystem: 'esm' | 'commonjs' | 'unknown'
  lockfileVersions: Record<string, string>
  frameworks: { detected: string[]; notDetected: string[] }
  negativeFacts: string[]
  tsconfigPaths: Record<string, string[]>
}

const FRAMEWORKS: Array<{ id: string; label: string; packages: string[] }> = [
  { id: 'express', label: 'Express', packages: ['express'] },
  { id: 'nestjs', label: 'NestJS', packages: ['@nestjs/core', '@nestjs/common'] },
  { id: 'nextjs', label: 'Next.js', packages: ['next'] },
  { id: 'fastify', label: 'Fastify', packages: ['fastify'] },
  { id: 'koa', label: 'Koa', packages: ['koa'] },
  { id: 'hono', label: 'Hono', packages: ['hono'] },
]

function parseJson(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}

export async function extractRepoFacts(
  files: Record<string, string | undefined>
): Promise<NodeRepoFacts> {
  const pkg = parseJson(files['package.json']) ?? {}
  const lock = parseJson(files['package-lock.json']) ?? {}
  const tsconfig = parseJson(files['tsconfig.json']) ?? {}

  const lockfileVersions: Record<string, string> = {}
  const packages = (lock.packages as Record<string, { version?: string }> | undefined) ?? {}
  for (const [path, entry] of Object.entries(packages)) {
    if (
      path.startsWith('node_modules/') &&
      !path.slice(13).includes('node_modules/') &&
      entry.version
    ) {
      lockfileVersions[path.slice(13)] = entry.version
    }
  }
  const declared = {
    ...(pkg.dependencies as object),
    ...(pkg.devDependencies as object),
  } as Record<string, string>
  const present = (name: string) => name in lockfileVersions || name in declared

  const detected = FRAMEWORKS.filter((f) => f.packages.some(present))
  const notDetected = FRAMEWORKS.filter((f) => !f.packages.some(present))
  const compilerOptions = (tsconfig.compilerOptions as Record<string, unknown> | undefined) ?? {}

  return {
    nodeVersion: ((pkg.engines as Record<string, string> | undefined)?.node as string) ?? null,
    typescriptVersion: lockfileVersions.typescript ?? null,
    moduleSystem:
      pkg.type === 'module'
        ? 'esm'
        : pkg.type === 'commonjs' || 'main' in pkg
          ? 'commonjs'
          : 'unknown',
    lockfileVersions,
    frameworks: { detected: detected.map((f) => f.id), notDetected: notDetected.map((f) => f.id) },
    negativeFacts: notDetected.map((f) => `${f.label} not detected`),
    tsconfigPaths: (compilerOptions.paths as Record<string, string[]> | undefined) ?? {},
  }
}
