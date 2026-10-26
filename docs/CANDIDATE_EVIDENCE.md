# 候选包与验证证据

候选包用于本地验收或CI运行留档，不等于已发布版本，也不证明安装、升级或卸载通过。生成前完成源码、文档与规格的最后修改，构建并记录实际检查；生成后若源码继续变化，应重新构建、验证并使用新输出目录。

从项目根目录运行：

```powershell
node scripts/candidate-evidence.mjs --installer "desktop/src-tauri/target/release/bundle/nsis/归简_0.1.0_x64-setup.exe" --verification "desktop/src-tauri/target/output/verification.json" --output "desktop/src-tauri/target/output/candidates/local-001"
```

`verification.json` 由执行者记录，结构为 `{"checks":[{"name":"frontend_tests","status":"passed","command":"pnpm test"}, ...]}`，省略号须换成完整实际记录，不是可直接执行的JSON。必需项目：`node_tests`、`frontend_tests`、`frontend_build`、`rust_fmt`、`rust_clippy`、`rust_tests`、`installer_build`、`windows_shell`、`native_smoke`、`native_close`、`installation`。前七项须通过；专项未执行时明确写 `not_run`，不能以构建成功替代专项验收。状态可为 `passed`、`failed`、`not_run`、`skipped`、`unknown`；可另加浏览器等检查，保留真实命令和报告线索。

输出须位于项目的Git忽略目录，避免候选自身污染源码快照。目录保存指定安装包、`SHA256SUMS.txt`、`source.json`、`verification.json`。源码身份包含HEAD、dirty状态、版本及文件指纹，覆盖已跟踪与非忽略的未跟踪文件；删除项记录为空摘要，不复制源码内容或整个环境变量。校验和覆盖包与记录文件。生成时缺少输入、记录无效或输出目录已存在均报错，不覆盖旧候选。

工具只保存显式输入，不代替运行检查，也不证明任意给定安装包由当前源码构建；执行者仍须保持构建、检查与生成的源码一致。包的摘要用于核对具体字节，未签名的候选不能由摘要推导发布者身份。

## 接口与校验

适用范围是本地/CI构建完成后的留档。CLI要求三个参数：`--installer`指定非空普通`.exe`文件，`--verification`指定普通JSON文件，`--output`指定项目Git忽略目录中的新目录。模块导出 `createCandidate({installer, verification, output, projectRoot?})` 供合成仓库自检使用。

`source.json` 的 `schemaVersion=1`；`head`为实际Git HEAD，`dirty`包含未提交和非忽略未跟踪状态，`versions`记录前端/Tauri/Rust与固定工具链，`files`记录path/status/sha256，删除项摘要为null；`fingerprintSha256`是有序files数组JSON的SHA256。`ci`仅收集repository、commit、runId、runAttempt和workflow，不收集其他环境变量。检查记录原样复制，不改写其状态。

| 输入条件 | 结果 |
| --- | --- |
| 缺包、空包、非exe、缺JSON或无效JSON | 生成失败 |
| 缺必需检查、重复名称、未知状态、前七项非passed | 生成失败 |
| 已有输出或输出不在项目Git忽略目录 | 拒绝覆盖/生成 |

正常例：核心检查通过、安装专项`not_run`，候选保留这一缺口。基础例：干净checkout记录HEAD与文件摘要；本地dirty额外反映变化。错误例：仅把安装包存在视为所有检查通过。

`node --test scripts/candidate-evidence.test.mjs` 核对精确包/记录摘要、clean与dirty/删除/未跟踪指纹、缺输入和无覆盖；`scripts/native-smoke-exit.test.mjs`另验证原生退出判定。禁止把手写passed当作工具完成了测试；正确做法是执行检查、记录真实结果，再以同一源码和包生成证据。

## CI 留档

现有CI在Node、前端、Rust检查与NSIS构建成功后生成相同证据，记录本job实际步骤结果和GitHub运行身份。独立Shell专项、原生专项和安装验收在此job未运行，记录为 `not_run`。使用固定commit的官方 `actions/upload-artifact`，请求保存14天，缺文件失败；产物位于对应workflow run的Artifacts区域，不创建Release、不修改仓库内容权限。

Action依据为 [v7.0.2固定源码](https://github.com/actions/upload-artifact/blob/cf430e030ddbb5b0abf93d22962f4752f3646cd9/action.yml)，本轮核验于2026-10-26。本地检查不证明远端runner或上传已成功；实际留存受仓库保留策略约束。
