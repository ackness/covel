---
name: dashscope-image-gen/image-generator
description:
  zh: 根据整理好的画面需求生成图片，并保存到画廊。
  en: Generates an illustration from the prepared scene brief and saves it to the gallery.
pluginType: plugin
# Event-triggered follower (topic below) — not part of the stage DAG, so it
# declares no stage. (Migrated from legacy `priority: 610`.)
runtimeType: function
handler: ./handler.js
outputKind: plugin
capabilities: [image-generation]
execution: background
timeoutMs: 360000
trigger:
  type: event
  topic: image.generate.requested
userSettings:
  - key: modelPresetId
    type: text
    default: image
    label:
      zh: 服务配置
      en: Service setup
    description:
      zh: 选择设置里用于生成图片的服务配置。默认使用 image。
      en: Choose the service setup used for image generation. Defaults to image.
  - key: imageSize
    type: text
    default: 1024x1024
    label:
      zh: 尺寸
      en: Size
    description:
      zh: 图片大小。默认是方图，也可以填写横图或竖图尺寸。
      en: Image size. The default is square; you can also choose wide or tall sizes.
  - key: "n"
    type: number
    default: 1
    label:
      zh: 一次生成几张
      en: Images per click
    description:
      zh: 每次点击生成几张图。当前服务通常一次生成一张。
      en: How many images to create per click. This service usually creates one image at a time.
  - key: requestTimeoutMs
    type: number
    default: 300000
    label:
      zh: 单次等待时间
      en: Wait limit
    description:
      zh: 单次生成最多等待多久，避免图片任务一直停住。
      en: Maximum wait for one generation, so an image task does not stay stuck.
  - key: quality
    type: text
    default: low
    label:
      zh: 画质（可选）
      en: Quality (optional)
    description:
      zh: 留空时使用默认画质。想更快、更省时可以选择较低画质。
      en: Leave blank for the default quality. Choose lower quality for faster, cheaper results.
  - key: negativePrompt
    type: textarea
    default: "low quality, blurry, watermark, text, extra fingers, distorted anatomy"
    label:
      zh: 避免出现的内容
      en: Things to avoid
    description:
      zh: 写下你希望图片避免出现的内容，比如模糊、水印或多余手指。
      en: Write things you want the image to avoid, such as blur, watermarks, or extra fingers.
ui:
  right:
    - ./ui/gallery.json
    - ./ui/jobs.json
---
