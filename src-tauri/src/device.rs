//! COM is created, invoked and destroyed on one dedicated STA thread.
//! No COM pointer ever crosses a Tauri async executor thread.
use crate::models::*;
use serde::Serialize;
use std::{path::PathBuf, sync::mpsc};

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStatus {
    pub connected: bool,
    pub sdk_available: bool,
    pub record_count: Option<i32>,
    pub sdk_source: String,
    pub error: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub loaded: usize,
    pub total: Option<i32>,
    pub message: String,
}
type Job = Box<dyn FnOnce(&mut native::Session) + Send>;
pub struct DeviceWorker {
    sender: mpsc::Sender<Job>,
}
impl DeviceWorker {
    pub fn new(resources: PathBuf) -> Self {
        let (sender, receiver) = mpsc::channel::<Job>();
        std::thread::Builder::new()
            .name("zk-sdk-sta".into())
            .spawn(move || {
                let mut session = native::Session::new(resources);
                while let Ok(job) = receiver.recv() {
                    job(&mut session);
                }
            })
            .expect("无法启动设备通信线程");
        Self { sender }
    }
    async fn execute<T: Send + 'static>(
        &self,
        action: impl FnOnce(&mut native::Session) -> AppResult<T> + Send + 'static,
    ) -> AppResult<T> {
        let (tx, rx) = mpsc::sync_channel(1);
        self.sender
            .send(Box::new(move |session| {
                let _ = tx.send(action(session));
            }))
            .map_err(|_| "设备工作线程已关闭".to_string())?;
        tauri::async_runtime::spawn_blocking(move || {
            rx.recv()
                .map_err(|_| "设备工作线程未返回结果".to_string())?
        })
        .await
        .map_err(|e| e.to_string())?
    }
    pub async fn status(&self) -> AppResult<DeviceStatus> {
        self.execute(|s| Ok(s.status())).await
    }
    pub async fn connect(&self, settings: ConnectionSettings) -> AppResult<DeviceStatus> {
        self.execute(move |s| {
            s.connect(&settings)?;
            Ok(s.status())
        })
        .await
    }
    pub async fn disconnect(&self) -> AppResult<DeviceStatus> {
        self.execute(|s| {
            s.disconnect()?;
            Ok(s.status())
        })
        .await
    }
    pub async fn download(
        &self,
        range: DateRange,
        progress: impl Fn(Progress) + Send + 'static,
    ) -> AppResult<Vec<LogRecord>> {
        self.execute(move |s| s.download(&range, &progress)).await
    }
}

mod native {
    use super::*;
    use chrono::NaiveDate;
    use std::{cell::RefCell, collections::HashMap, ffi::c_void, mem::ManuallyDrop, path::Path};
    use windows::{
        core::{s, w, Interface, BSTR, GUID, HRESULT, PCWSTR},
        Win32::{
            Foundation::{FreeLibrary, HMODULE},
            System::{
                Com::*,
                LibraryLoader::*,
                Ole::{LoadTypeLibEx, REGKIND_NONE},
                Variant::*,
            },
        },
    };

    struct Module(HMODULE);
    impl Drop for Module {
        fn drop(&mut self) {
            unsafe {
                let _ = FreeLibrary(self.0);
            }
        }
    }
    struct SearchDirectory(*mut c_void);
    impl Drop for SearchDirectory {
        fn drop(&mut self) {
            unsafe {
                let _ = RemoveDllDirectory(self.0);
            }
        }
    }
    struct Sdk {
        dispatch: IDispatch,
        _module: Option<Module>,
        _search_directory: Option<SearchDirectory>,
        source: String,
        ids: RefCell<HashMap<String, i32>>,
    }
    impl Sdk {
        fn open(resources: &Path) -> AppResult<Self> {
            if !cfg!(target_arch = "x86_64") {
                return Err("随附 SDK 要求 Windows x64，请使用 x86_64-pc-windows-msvc 构建".into());
            }
            let mut path = resources.join("resources/sdk/zkemkeeper.dll");
            if cfg!(debug_assertions) && !path.exists() {
                path = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/sdk/zkemkeeper.dll");
            }
            if path.exists() {
                return Self::load_direct(&path).map_err(|e| format!("无法加载随附的 64 位 SDK：{e}。请检查 SDK DLL 是否完整及 VC++ 运行库是否已安装。"));
            }
            unsafe {
                let clsid = CLSIDFromProgID(w!("zkemkeeper.ZKEM"))
                    .map_err(|_| "未找到随附 SDK，也没有注册 64 位 zkemkeeper 组件".to_string())?;
                let dispatch = CoCreateInstance(&clsid, None, CLSCTX_INPROC_SERVER)
                    .map_err(|e| e.to_string())?;
                Ok(Self {
                    dispatch,
                    _module: None,
                    _search_directory: None,
                    source: "系统注册的 64 位 SDK".into(),
                    ids: RefCell::new(HashMap::new()),
                })
            }
        }
        fn load_direct(path: &Path) -> AppResult<Self> {
            let wide: Vec<u16> = path
                .as_os_str()
                .to_string_lossy()
                .encode_utf16()
                .chain(Some(0))
                .collect();
            // SAFETY: the absolute DLL path and all COM calls live on this STA. Module ownership
            // outlives dispatch; the type library is read without changing the registry.
            unsafe {
                // The vendor loads transport DLLs dynamically. Include only the application,
                // System32 and this explicit SDK directory, never the working directory.
                SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS)
                    .map_err(|e| e.to_string())?;
                let directory: Vec<u16> = path
                    .parent()
                    .ok_or("SDK 目录无效")?
                    .as_os_str()
                    .to_string_lossy()
                    .encode_utf16()
                    .chain(Some(0))
                    .collect();
                let cookie = AddDllDirectory(PCWSTR(directory.as_ptr()));
                if cookie.is_null() {
                    return Err(format!(
                        "SDK 搜索目录：{}",
                        windows::core::Error::from_win32()
                    ));
                }
                let search_directory = SearchDirectory(cookie);
                let module = Module(
                    LoadLibraryExW(
                        PCWSTR(wide.as_ptr()),
                        None,
                        LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
                    )
                    .map_err(|e| format!("加载 DLL：{e}"))?,
                );
                let library = LoadTypeLibEx(PCWSTR(wide.as_ptr()), REGKIND_NONE)
                    .map_err(|e| format!("读取类型库：{e}"))?;
                let mut clsid = None;
                for i in 0..library.GetTypeInfoCount() {
                    if library.GetTypeInfoType(i).map_err(|e| e.to_string())? == TKIND_COCLASS {
                        let info = library.GetTypeInfo(i).map_err(|e| e.to_string())?;
                        let attr = info.GetTypeAttr().map_err(|e| e.to_string())?;
                        clsid = Some((*attr).guid);
                        info.ReleaseTypeAttr(attr);
                        break;
                    }
                }
                let clsid = clsid.ok_or("SDK 类型库未提供 COM 类")?;
                let proc = GetProcAddress(module.0, s!("DllGetClassObject"))
                    .ok_or("SDK 缺少 DllGetClassObject")?;
                type GetClass = unsafe extern "system" fn(
                    *const GUID,
                    *const GUID,
                    *mut *mut c_void,
                ) -> HRESULT;
                let get_class: GetClass = std::mem::transmute(proc);
                let mut raw = std::ptr::null_mut();
                get_class(&clsid, &IClassFactory::IID, &mut raw)
                    .ok()
                    .map_err(|e| e.to_string())?;
                if raw.is_null() {
                    return Err("SDK 未返回类工厂".into());
                }
                let factory = IClassFactory::from_raw(raw);
                let dispatch: IDispatch = factory
                    .CreateInstance(None)
                    .map_err(|e| format!("创建 SDK：{e}"))?;
                Ok(Self {
                    dispatch,
                    _module: Some(module),
                    _search_directory: Some(search_directory),
                    source: "内置 SDK 6.3.1.37 · x64 · 免注册".into(),
                    ids: RefCell::new(HashMap::new()),
                })
            }
        }
        fn invoke(&self, name: &str, mut args: Vec<VARIANT>) -> AppResult<VARIANT> {
            unsafe {
                let cached = self.ids.borrow().get(name).copied();
                let dispid = if let Some(id) = cached {
                    id
                } else {
                    let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
                    let mut id = 0;
                    self.dispatch
                        .GetIDsOfNames(&GUID::zeroed(), &PCWSTR(wide.as_ptr()), 1, 0, &mut id)
                        .map_err(|e| format!("SDK 不支持 {name}：{e}"))?;
                    self.ids.borrow_mut().insert(name.into(), id);
                    id
                };
                // IDispatch arguments are right-to-left. BYREF pointees remain alive until Invoke returns.
                args.reverse();
                let params = DISPPARAMS {
                    rgvarg: args.as_mut_ptr(),
                    cArgs: args.len() as u32,
                    ..Default::default()
                };
                let mut output = VARIANT::default();
                let mut exception = EXCEPINFO::default();
                let result = self.dispatch.Invoke(
                    dispid,
                    &GUID::zeroed(),
                    0,
                    DISPATCH_METHOD,
                    &params,
                    Some(&mut output),
                    Some(&mut exception),
                    None,
                );
                if let Some(fill) = exception.pfnDeferredFillIn {
                    let _ = fill(&mut exception);
                }
                let description = exception.bstrDescription.to_string();
                ManuallyDrop::drop(&mut exception.bstrSource);
                ManuallyDrop::drop(&mut exception.bstrDescription);
                ManuallyDrop::drop(&mut exception.bstrHelpFile);
                result.map_err(|e| format!("{name} 调用失败：{e} {description}"))?;
                Ok(output)
            }
        }
        fn boolean(&self, name: &str, args: Vec<VARIANT>) -> AppResult<bool> {
            sdk_boolean(&self.invoke(name, args)?).map_err(|e| format!("{name} 返回值无效：{e}"))
        }
        fn set_comm_password(&self, comm_key: i32) -> AppResult<()> {
            // This configures the client's next connection; it does not contact the device.
            if !self.boolean("SetCommPassword", vec![comm_key.into()])? {
                return Err(format!(
                    "设置客户端通讯密码失败，SDK 错误码 {}",
                    self.last_error()
                ));
            }
            Ok(())
        }
        fn last_error(&self) -> i32 {
            let mut code = -1;
            let _ = self.invoke("GetLastError", vec![ref_i32(&mut code)]);
            code
        }
        fn count(&self, machine: i32) -> Option<i32> {
            let mut count = 0;
            self.boolean(
                "GetDeviceStatus",
                vec![machine.into(), 6i32.into(), ref_i32(&mut count)],
            )
            .ok()
            .filter(|x| *x)
            .map(|_| count)
        }
    }
    fn sdk_boolean(value: &VARIANT) -> AppResult<bool> {
        // ZK SDK 6.3.1.37 returns VT_BOOL with the raw value 1 for success,
        // instead of COM's canonical VARIANT_TRUE (-1). VariantToBoolean (used
        // by bool::try_from) reads that as false. Match the legacy .NET client's
        // marshaling: a typed VARIANT_BOOL is true for any nonzero value.
        // SAFETY: the discriminant is checked before reading the union field.
        unsafe {
            let data = &value.Anonymous.Anonymous;
            if data.vt != VT_BOOL {
                return Err(format!("预期布尔类型，收到 VARIANT 类型 {}", data.vt.0));
            }
            Ok(data.Anonymous.boolVal.0 != 0)
        }
    }
    fn ref_i32(value: &mut i32) -> VARIANT {
        VARIANT {
            Anonymous: VARIANT_0 {
                Anonymous: ManuallyDrop::new(VARIANT_0_0 {
                    vt: VT_I4 | VT_BYREF,
                    Anonymous: VARIANT_0_0_0 { plVal: value },
                    ..Default::default()
                }),
            },
        }
    }
    fn ref_bstr(value: &mut BSTR) -> VARIANT {
        VARIANT {
            Anonymous: VARIANT_0 {
                Anonymous: ManuallyDrop::new(VARIANT_0_0 {
                    vt: VT_BSTR | VT_BYREF,
                    Anonymous: VARIANT_0_0_0 { pbstrVal: value },
                    ..Default::default()
                }),
            },
        }
    }
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }
    pub struct Session {
        sdk: Option<Sdk>,
        apartment: Option<Apartment>,
        init_error: Option<String>,
        resources: PathBuf,
        connected: bool,
        machine: i32,
    }
    impl Session {
        pub fn new(resources: PathBuf) -> Self {
            let result = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok() };
            Self {
                sdk: None,
                apartment: result.as_ref().ok().map(|_| Apartment),
                init_error: result.err().map(|e| e.to_string()),
                resources,
                connected: false,
                machine: 1,
            }
        }
        fn ensure_sdk(&mut self) -> AppResult<&Sdk> {
            if let Some(error) = &self.init_error {
                return Err(format!("COM 初始化失败：{error}"));
            }
            if self.sdk.is_none() {
                self.sdk = Some(Sdk::open(&self.resources)?);
            }
            Ok(self.sdk.as_ref().unwrap())
        }
        pub fn status(&mut self) -> DeviceStatus {
            let error = self.ensure_sdk().err();
            DeviceStatus {
                connected: self.connected,
                sdk_available: self.sdk.is_some(),
                record_count: if self.connected {
                    self.sdk.as_ref().and_then(|s| s.count(self.machine))
                } else {
                    None
                },
                sdk_source: self
                    .sdk
                    .as_ref()
                    .map(|s| s.source.clone())
                    .unwrap_or_default(),
                error,
            }
        }
        pub fn connect(&mut self, settings: &ConnectionSettings) -> AppResult<()> {
            settings.validate(true)?;
            self.disconnect()?;
            self.machine = settings.machine_number;
            let sdk = self.ensure_sdk()?;
            sdk.set_comm_password(settings.comm_key)?;
            if !sdk.boolean(
                "Connect_Net",
                vec![
                    settings.ip_address.as_str().into(),
                    (settings.port as i32).into(),
                ],
            )? {
                return Err(format!(
                    "无法连接考勤机，SDK 错误码 {}。请检查设备 IP、通讯密码和局域网连接。",
                    sdk.last_error()
                ));
            }
            self.connected = true;
            Ok(())
        }
        pub fn disconnect(&mut self) -> AppResult<()> {
            if self.connected {
                if let Some(sdk) = &self.sdk {
                    sdk.invoke("Disconnect", vec![])?;
                }
                self.connected = false;
            }
            Ok(())
        }
        pub fn download(
            &mut self,
            range: &DateRange,
            progress: &dyn Fn(Progress),
        ) -> AppResult<Vec<LogRecord>> {
            range.validate()?;
            if !self.connected {
                return Err("请先连接考勤机".into());
            }
            let sdk = self.sdk.as_ref().ok_or("SDK 尚未初始化")?;
            let total = sdk.count(self.machine);
            progress(Progress {
                loaded: 0,
                total,
                message: "正在从设备读取记录…".into(),
            });
            // Reading is intentionally non-destructive: no log clearing, time setting, or enrollment calls.
            let from = format!("{} 00:00:00", range.start_date);
            let to = format!("{} 23:59:59", range.end_date);
            let period = sdk
                .boolean(
                    "ReadTimeGLogData",
                    vec![
                        self.machine.into(),
                        from.as_str().into(),
                        to.as_str().into(),
                    ],
                )
                .unwrap_or(false);
            if !period && !sdk.boolean("ReadGeneralLogData", vec![self.machine.into()])? {
                let error = sdk.last_error();
                if error == 0 {
                    return Ok(vec![]);
                }
                return Err(format!("读取打卡记录失败，SDK 错误码 {error}"));
            }
            let mut logs = Vec::new();
            let mut loaded = 0;
            loop {
                let mut user = BSTR::new();
                let mut values = [0i32; 9];
                let mut args = vec![self.machine.into(), ref_bstr(&mut user)];
                args.extend(values.iter_mut().map(ref_i32));
                if !sdk.boolean("SSR_GetGeneralLogData", args)? {
                    break;
                }
                loaded += 1;
                if loaded > 2_000_000 {
                    return Err("设备返回超过 200 万条记录，已停止，请缩小查询范围".into());
                }
                let [verify, mode, year, month, day, hour, minute, second, work] = values;
                let timestamp = NaiveDate::from_ymd_opt(year, month as u32, day as u32)
                    .and_then(|d| d.and_hms_opt(hour as u32, minute as u32, second as u32))
                    .ok_or_else(|| {
                        format!("设备第 {loaded} 条记录含无效时间，已停止保存以避免不完整统计")
                    })?;
                if range.contains(timestamp.date()) {
                    logs.push(LogRecord {
                        id: 0,
                        user_id: user.to_string(),
                        timestamp,
                        verify_mode: verify,
                        in_out_mode: mode,
                        work_code: work,
                    });
                }
                if loaded % 100 == 0 {
                    progress(Progress {
                        loaded,
                        total,
                        message: format!("已读取 {loaded} 条，范围内 {} 条", logs.len()),
                    });
                }
            }
            progress(Progress {
                loaded,
                total,
                message: format!("读取完成，范围内 {} 条记录", logs.len()),
            });
            Ok(logs)
        }
    }
    impl Drop for Session {
        fn drop(&mut self) {
            let _ = self.disconnect();
            self.sdk.take();
            self.apartment.take();
        }
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn bundled_sdk_loads_without_registry_changes() {
            let mut session = Session::new(PathBuf::from(env!("CARGO_MANIFEST_DIR")));
            let status = session.status();
            assert!(status.sdk_available, "{:?}", status.error);
            let sdk = session.sdk.as_ref().unwrap();
            // Resolves the real SDK's automation interface without connecting to hardware.
            assert!(sdk.invoke("GetLastError", vec![ref_i32(&mut 0)]).is_ok());
        }
        #[test]
        fn bundled_sdk_accepts_password_before_connecting() {
            let mut session = Session::new(PathBuf::from(env!("CARGO_MANIFEST_DIR")));
            let sdk = session.ensure_sdk().unwrap();
            for comm_key in [0, 123456, 999999] {
                // Real SDK regression: setting a valid local key must not require an
                // established network connection. No device is contacted by this test.
                sdk.set_comm_password(comm_key).unwrap();
            }
            assert!(!session.connected);
        }
        #[test]
        fn bundled_sdk_reads_version_and_success_together() {
            let mut session = Session::new(PathBuf::from(env!("CARGO_MANIFEST_DIR")));
            let sdk = session.ensure_sdk().unwrap();
            let mut version = BSTR::new();
            assert!(sdk
                .boolean("GetSDKVersion", vec![ref_bstr(&mut version)])
                .unwrap());
            assert_eq!(version.to_string(), "6.3.1.37");
        }
        #[test]
        fn sdk_boolean_accepts_vendor_and_com_true_but_preserves_false() {
            for (raw, expected) in [(0, false), (1, true), (-1, true)] {
                let mut value = VARIANT::from(false);
                // SAFETY: this is a VT_BOOL variant; the field stays the same type.
                unsafe {
                    (*value.Anonymous.Anonymous).Anonymous.boolVal.0 = raw;
                }
                assert_eq!(sdk_boolean(&value).unwrap(), expected);
            }
            assert!(sdk_boolean(&VARIANT::default()).is_err());
            assert!(sdk_boolean(&VARIANT::from(1i32)).is_err());
        }
    }
}
