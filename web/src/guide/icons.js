import {
  ArchiveOutline, CloudOutline, CloudUploadOutline, ContrastOutline, FolderOpenOutline, HelpCircleOutline, ImagesOutline, KeypadOutline, LockClosedOutline, MenuOutline, MoveOutline,
  NotificationsOutline, PeopleCircleOutline, PersonOutline, SearchOutline, ServerOutline, ShareSocialOutline, SparklesOutline, SpeedometerOutline, SyncOutline, TrashOutline,
} from '@vicons/ionicons5'

const icons = {
  menu: MenuOutline, system: ServerOutline, help: HelpCircleOutline, theme: ContrastOutline, dav: CloudOutline, groups: PeopleCircleOutline,
  gallery: ImagesOutline, trash: TrashOutline, drag: MoveOutline, bell: NotificationsOutline, share: ShareSocialOutline, backup: ArchiveOutline,
  upload: CloudUploadOutline, users: PersonOutline, folder: FolderOpenOutline, search: SearchOutline, lock: LockClosedOutline, keys: KeypadOutline,
  dashboard: SpeedometerOutline, update: SyncOutline,
}
/** the icon of a release item or help topic, by the name used in releases.js / topics.js */
export const iconOf = name => icons[name] || SparklesOutline
