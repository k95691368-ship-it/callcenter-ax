import { describe, it, expect } from 'vitest'
import { extractJson, callWorkersJson, WORKERS_LLM_MODEL } from '../functions/_lib/workersLlm.js'

describe('extractJson', () => {
  it('앞뒤 설명이 붙은 응답에서 JSON만 파싱한다', () => {
    const text = '네, 분석 결과입니다:\n{"category":"요금","escalate":false}\n이상입니다.'
    expect(extractJson(text)).toEqual({ category: '요금', escalate: false })
  })

  it('코드펜스로 감싼 JSON도 파싱한다', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('JSON이 없으면 거부한다', () => {
    expect(() => extractJson('죄송합니다, 답할 수 없습니다.')).toThrow(/JSON/)
  })

  it('중첩 객체를 온전히 파싱한다', () => {
    expect(extractJson('{"summary":["a"],"x":{"y":2}}')).toEqual({ summary: ['a'], x: { y: 2 } })
  })
})

describe('callWorkersJson', () => {
  it('AI 바인딩의 응답을 JSON으로 반환한다', async () => {
    const env = {
      AI: {
        run: async (model, input) => {
          expect(model).toBe(WORKERS_LLM_MODEL)
          expect(input.messages).toHaveLength(2)
          return { response: '{"empathy":15,"comments":["good"]}' }
        },
      },
    }
    const { input, model } = await callWorkersJson(env, { system: 's', user: 'u' })
    expect(input.empathy).toBe(15)
    expect(model).toBe(WORKERS_LLM_MODEL)
  })

  it('OpenAI 호환 형태(choices[0].message.content)도 파싱한다', async () => {
    const env = {
      AI: {
        run: async () => ({
          choices: [{ message: { role: 'assistant', content: '{"category":"요금","escalate":true}' } }],
        }),
      },
    }
    const { input } = await callWorkersJson(env, { system: 's', user: 'u' })
    expect(input).toEqual({ category: '요금', escalate: true })
  })

  it('AI 바인딩이 없으면 거부한다', async () => {
    await expect(callWorkersJson({}, { system: 's', user: 'u' })).rejects.toThrow(/바인딩/)
  })

  it('빈 응답은 거부한다', async () => {
    const env = { AI: { run: async () => ({ response: '' }) } }
    await expect(callWorkersJson(env, { system: 's', user: 'u' })).rejects.toThrow()
  })
})
