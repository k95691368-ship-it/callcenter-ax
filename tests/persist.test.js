import { describe, it, expect, beforeEach, vi } from 'vitest'
import { loadPersisted, savePersisted } from '../src/lib/persist.js'

// node 환경에는 localStorage가 없으므로 Map 기반 스텁을 쓴다
const store = new Map()
beforeEach(() => {
  store.clear()
  vi.stubGlobal('localStorage', {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  })
})

describe('loadPersisted / savePersisted', () => {
  it('저장한 값을 그대로 복원한다', () => {
    savePersisted('k', [{ label: '청약철회', keywords: 'a,b' }])
    expect(loadPersisted('k', [])).toEqual([{ label: '청약철회', keywords: 'a,b' }])
  })

  it('없거나 깨진 값은 초기값으로 안전하게 돌아간다', () => {
    expect(loadPersisted('none', 'init')).toBe('init')
    store.set('bad', '{깨진 JSON')
    expect(loadPersisted('bad', 'init')).toBe('init')
    store.set('null', 'null')
    expect(loadPersisted('null', 'init')).toBe('init')
  })

  it('localStorage가 아예 없어도 던지지 않는다', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(loadPersisted('k', 7)).toBe(7)
    expect(() => savePersisted('k', 1)).not.toThrow()
  })
})
