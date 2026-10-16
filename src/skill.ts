import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'

/** Skill name shown in the catalog and used when routing. */
export const SKILL_NAME = 'qwen-image-forge'

/** Short catalog blurb; the routing keywords live here, not in the body. */
const SKILL_DESCRIPTION =
  '用 Qwen-Image（千问生图）出图：把口语需求按提示词契约改写成成品 prompt，并把契约里的 wh_ratio ' +
  '直接作为工具的一等参数出图（无需人工换算像素）。当用户要求生成图片、出海报/头像/封面/壁纸、' +
  '按指定画幅比出图，或要给了一/多张参考图的改图、融图需求写指令时使用。仅面向 Qwen-Image 模型。'

/** Reference documents the body points at, loaded from the package root. */
const REFERENCE_FILES = ['references/t2i_rules.md', 'references/edit_rules.md'] as const

/** Resolve one package-relative file, or undefined when it is not shipped. */
function resolveFile(relative: string): string | undefined {
  try {
    return fileURLToPath(new URL(`../${relative}`, import.meta.url))
  } catch {
    return undefined
  }
}

/**
 * Compose the skill body.
 *
 * `skill.md` is the model-facing routing document; the two reference files are
 * shipped beside it and are only useful if the model can open them, so their
 * resolved absolute paths are appended — the body must not promise files the
 * model cannot reach. A missing reference degrades to a note instead of
 * breaking plugin load.
 */
function composeContent(): string {
  const body = readFileSync(new URL('../skill.md', import.meta.url), 'utf8')
  const lines = REFERENCE_FILES.map((relative) => {
    const absolute = resolveFile(relative)
    return absolute === undefined
      ? `- \`${relative}\` —— 未随包分发，请只用本技能正文里的规则`
      : `- \`${relative}\`（本机绝对路径：\`${absolute}\`，用 read 工具按此路径打开）`
  })
  return `${body}\n> 下面两处路径由插件在注册时填入，可直接用 read 工具打开：\n${lines.join('\n')}\n`
}

/**
 * Register the runtime skill so the model discovers the routing guidance
 * through the skill catalog and loads the full body on demand.
 *
 * @param ctx - cordis context providing `skills`.
 */
export function registerImageForgeSkill(ctx: Context): void {
  const skill: SkillRegistration = {
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    source: 'runtime',
    content: composeContent(),
  }
  ctx.skills.register(skill)
}
