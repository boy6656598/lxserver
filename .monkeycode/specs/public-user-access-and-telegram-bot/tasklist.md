# 需求实施计划：对外开放用户注册与 TG 机器人

- [ ] 1. 实现用户账号模型与 userAccount.ts
  - [x] 1.1 扩展用户类型定义与持久化
    - 在 `src/types/config.d.ts` 的 UserConfig 增加 `expireAt/banned/lastActiveAt/activeSeconds/periodStart/telegramId`（对应需求 R2、R4）
    - `server.ts` saveUsers 保存扩展字段；注册逻辑初始化账号字段；热重载加载时兼容旧数据缺失字段补默认值

  - [x] 1.2 实现 userAccount.ts 账号状态中枢
    - 新建 `src/server/userAccount.ts`：registerUser/bindTelegram/recordActivity/checkUserAccess/renewExpire/setExpire/setBanned/listAccounts/initAccountManager（对应需求 R2、R3、R4、R5、R6）
    - recordActivity 节流累加活跃秒（单次差值上限 60s）；checkUserAccess 校验 banned 与过期

  - [x] 1.3 实现活跃续期与自动封禁定时任务
    - initAccountManager 启动每日定时扫描：30 天周期活跃 ≥300s 自动续期 30 天；非永久且 lastActiveAt 超 N 天自动封禁（对应需求 R3、R5 与设计 Correctness Properties 1、2、3）

  - [ ]* 1.4 编写账号模型单元测试
    - 活跃续期边界（周期满/活跃达标）、封禁边界（N 天阈值）、活跃累加节流、永久账号豁免

- [ ] 2. 配置扩展与后端接入
  - [x] 2.1 新增配置项
    - `defaultConfig.ts` 与 config 类型新增 `telegram.enable`、`telegram.botToken`、`user.autoBanInactiveDays`、`server.publicUrl`（对应需求 R5、R8）

  - [x] 2.2 Web 请求活跃记录
    - 在已鉴权（x-user-token / session cookie）的 API 入口调用 recordActivity；启动时调用 initAccountManager（对应需求 R4）

  - [x] 2.3 播放端登录拦截
    - `/api/user/login` 对普通注册用户拒绝（仅管理员后台密码可进播放端）；播放端登录仅接受 frontend.password（对应需求 R1）

  - [x] 2.4 Subsonic 到期/封禁校验
    - `subsonic.ts` 用户密码认证建立会话处插入 checkUserAccess，拒绝到期/封禁用户（对应需求 R2、R5）

  - [x] 2.5 检查点 - 构建与既有测试通过，如有疑问询问用户

- [ ] 3. 管理后台 API 与前端
  - [x] 3.1 用户管理 API 扩展
    - `/api/users` 返回扩展字段；新增设置有效期（7/30/365/永久）、手动续期、封禁/解封接口（对应需求 R2、R3、R5）

  - [x] 3.2 配置 API 扩展
    - config API 支持读写 `telegram.*`、`user.autoBanInactiveDays`、`server.publicUrl`（对应需求 R5、R8）

  - [x] 3.3 后台用户管理页展示与操作
    - 用户列表展示到期时间/上次活跃/活跃时长/封禁状态；提供设置时长、手动续期、封禁/解封按钮（对应需求 R2、R4、R5）

  - [x] 3.4 后台设置页
    - 新增 TG 机器人配置（Bot Token/开关）、封禁阈值、服务器对外地址表单（对应需求 R5、R8）

- [x] 4. TG 机器人
  - [x] 4.1 telegramBot.ts 基础框架
    - 新建 `src/server/telegramBot.ts`（grammY 长轮询）：读取 telegram.enable/botToken，初始化命令路由与用户绑定状态（对应需求 R6）；补充管理通知推送 `notify()`（telegram.chatId，注册/自动封禁时触发）

  - [x] 4.2 账号命令实现
    - `/register <用户名> <密码> <卡密>`、`/bind <用户名> <密码>`、`/changepassword <旧密码> <新密码>`、`/server`、`/status`，未绑定仅允许 start/register/bind，用户命令前执行 checkUserAccess（对应需求 R6、R7、R8）

  - [x] 4.3 playlistParser.ts 歌单解析
    - 新建 `src/server/playlistParser.ts`：文本（歌手-歌名/整行歌名）、LX JSON、平台链接（网易云/QQ 等）三种格式解析（对应需求 R9）

  - [x] 4.4 本地曲库对比与下载编排
    - 合并全量 music_index 对比缺失歌曲 → musicSdk 搜索为 songInfo → serverDownloadQueue.enqueue（对应需求 R9）

  - [x] 4.5 收藏歌单生成与结果回复
    - 下载完成后通过 ListManage 为该用户生成/更新"TG 歌单"，TG 回复统计（总数/已存在/已排队/失败）（对应需求 R9）

  - [x] 4.6 编写歌单解析单元测试
    - 文本格式、LX JSON、平台链接识别与边界（空歌单/无法解析）

- [x] 5. 版本升级与交付
  - [x] 5.1 版本号更新至 3.0.2
    - package.json/config.js/README 徽章/docker-compose/changelog/主页新增功能同步（对应交付约定）

  - [x] 5.2 本地构建与集成验证
    - npm run build 通过；本地启动验证注册/有效期/活跃记录/播放端拦截/Subsonic 校验

  - [x] 5.3 构建推送镜像 3.0.2 并提交推送 fork 分支
    - 代码与单测提交并推送至 fork 分支 `260811-feat-public-user-access-telegram-bot`（镜像推送由用户确认后另行执行）
