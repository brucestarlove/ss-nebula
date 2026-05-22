import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(import.meta.dirname, '..', 'src', 'nebula', 'ui', 'NebulaShell.css'), 'utf8')

function mediaBlock(maxWidth) {
  const marker = `@media (max-width: ${maxWidth}px) {`
  let start = css.indexOf(marker)
  if (start === -1) return ''
  const blocks = []

  while (start !== -1) {
    let depth = 0
    for (let index = start; index < css.length; index += 1) {
      if (css[index] === '{') depth += 1
      if (css[index] === '}') {
        depth -= 1
        if (depth === 0) {
          blocks.push(css.slice(start, index + 1))
          start = css.indexOf(marker, index + 1)
          break
        }
      }
    }
  }

  return blocks.join('\n')
}

describe('Nebula responsive Excalidraw chrome CSS', () => {
  it('normalizes the mobile misc tool strip before the narrowest phone breakpoint', () => {
    const css860 = mediaBlock(860)

    expect(css860).toContain('.excalidraw .mobile-misc-tools-container')
    expect(css860).toContain('background-color: transparent !important')
    expect(css860).toContain('box-shadow: none !important')
    expect(css860).toContain('width: 2.35rem !important')
    expect(css860).toContain('height: 2.35rem !important')
    expect(css860).toContain('.sidebar-trigger__label')
    expect(css860).toContain('display: none !important')
  })

  it('collapses the Personal Library trigger at the same mobile breakpoint', () => {
    const css860 = mediaBlock(860)
    const css640 = mediaBlock(640)

    expect(css860).toContain('.excalidraw .nebula-library-trigger--switch')
    expect(css860).toContain('width: 2.35rem !important')
    expect(css860).toContain('min-width: 2.35rem !important')
    expect(css860).toContain('.nebula-library-trigger--switch .nebula-library-trigger__label')
    expect(css860).toContain('display: none')
    expect(css640).toContain('.excalidraw .nebula-library-trigger:not(.nebula-library-trigger--switch)')
  })
})
