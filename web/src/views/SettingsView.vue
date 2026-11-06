<template>
  <div class="page settings">
    <page-header :title="t('nav.settings')" :description="t('settings.subtitle')" />
    <n-spin :show="loading">
      <div class="layout">
        <!-- the categories: a list on the left, a select on a phone -->
        <div class="cats" data-tour="settings-cats">
          <nav class="cat-nav" :aria-label="t('settings.categories')">
            <button v-for="c in CATS" :key="c.id" type="button" class="cat" :class="{ on: cat === c.id }" :aria-current="cat === c.id ? 'true' : undefined" :data-tour="`settings-cat-${c.id}`" @click="cat = c.id">
              <n-icon :component="c.icon" size="18" />
              <span class="cat-label">{{ t(`settings.cat.${c.id}`) }}</span>
              <span v-if="countOf(c.id)" class="cat-count" :title="t('settings.unsaved', { n: countOf(c.id) })">{{ countOf(c.id) }}</span>
            </button>
          </nav>
          <n-select v-model:value="cat" :options="catOptions" class="cat-select" :aria-label="t('settings.categories')" :consistent-menu-width="false" />
        </div>

        <div class="content" v-if="ready">
          <!-- ───────── general and brand ───────── -->
          <template v-if="cat === 'general'">
            <section class="surface block">
              <h2>{{ t('settings.brand') }}</h2>
              <setting-row :label="t('settings.appName')" :help="t('settings.appNameHelp')" :changed="isChanged('appName')" for-id="s-appname">
                <n-input :input-props="{ id: 's-appname' }" v-model:value="f.appName" :placeholder="t('settings.appName')" maxlength="60" class="ctl" />
              </setting-row>
              <setting-row :label="t('settings.color')" :help="t('settings.colorHelp')" :changed="isChanged('primaryColor')">
                <div class="colors">
                  <button v-for="c in presets" :key="c" type="button" class="swatch" :class="{ on: f.primaryColor.toLowerCase() === c }" :style="{ background: c }" :aria-label="c" @click="f.primaryColor = c" />
                  <n-color-picker v-model:value="f.primaryColor" :modes="['hex']" :show-alpha="false" style="width: 110px" />
                </div>
              </setting-row>
              <setting-row :label="t('settings.logo')" :help="t('settings.logoHint')">
                <div class="logo-field">
                  <img v-if="app.config.logo" :src="`/api/branding/logo?v=${encodeURIComponent(app.config.logo)}`" class="logo-prev" alt="">
                  <div class="logo-row">
                    <n-upload class="logo-upload" :show-file-list="false" accept="image/png,image/jpeg,image/webp,image/svg+xml" :custom-request="() => {}" :on-before-upload="onLogo">
                      <n-button secondary><template #icon><n-icon :component="ImageOutline" /></template>{{ t('settings.uploadLogo') }}</n-button>
                    </n-upload>
                    <n-button v-if="app.config.logo" secondary type="error" @click="removeLogo">{{ t('common.remove') }}</n-button>
                  </div>
                </div>
              </setting-row>
            </section>
            <section class="surface block">
              <h2>{{ t('settings.about') }}</h2>
              <div class="kv"><span class="muted">{{ t('dash.system') }}</span><span>v{{ app.config.version }}</span></div>
            </section>
          </template>

          <!-- ───────── the public page ───────── -->
          <template v-else-if="cat === 'public'">
            <section class="surface block">
              <h2>{{ t('settings.publicPage') }}</h2>
              <setting-row :label="t('settings.publicEnabled')" :help="t('settings.publicEnabledHelp')" :changed="isChanged('publicEnabled')">
                <n-switch v-model:value="f.publicEnabled" />
              </setting-row>
              <n-alert type="info" :show-icon="true" class="std">{{ t('settings.standardHint') }}</n-alert>
              <setting-row :label="t('settings.welcomeTitle')" :changed="isChanged('welcomeTitle')" for-id="s-wtitle">
                <n-input :input-props="{ id: 's-wtitle' }" v-model:value="f.welcomeTitle" maxlength="120" :placeholder="t('settings.stdWelcomeTitle')" clearable class="ctl wide" />
              </setting-row>
              <setting-row :label="t('settings.welcomeText')" :changed="isChanged('welcomeText')" for-id="s-wtext">
                <n-input :input-props="{ id: 's-wtext' }" v-model:value="f.welcomeText" type="textarea" :autosize="{ minRows: 3, maxRows: 6 }" maxlength="600" :placeholder="t('settings.stdWelcomeText')" clearable class="ctl wide" />
              </setting-row>
              <setting-row :label="t('settings.emptyText')" :changed="isChanged('publicEmptyText')" for-id="s-wempty">
                <n-input :input-props="{ id: 's-wempty' }" v-model:value="f.publicEmptyText" maxlength="300" :placeholder="t('settings.stdEmptyText')" clearable class="ctl wide" />
              </setting-row>
            </section>
            <section class="surface block">
              <h2>{{ t('settings.guestPerms') }}</h2>
              <setting-row :label="t('settings.guestBasic')" :help="t('settings.guestBasicHelp')" :changed="isChanged('guestPermissions')">
                <div class="perms">
                  <n-checkbox v-for="k in BASIC" :key="k" :checked="hasPerm(k)" :label="t(`perm.${k}`)" @update:checked="v => setPerm(k, v)" />
                </div>
              </setting-row>
              <n-collapse v-model:expanded-names="advOpen" class="adv" data-tour="settings-guest-advanced">
                <n-collapse-item name="adv" :title="t('settings.guestAdvanced')">
                  <n-alert type="error" :show-icon="true" class="adv-warn">{{ t('settings.guestWarn') }}</n-alert>
                  <div class="perms">
                    <n-checkbox v-for="k in ADVANCED" :key="k" :checked="hasPerm(k)" :label="t(`perm.${k}`)" @update:checked="v => setPerm(k, v)" />
                  </div>
                  <div class="muted help-s">{{ t('settings.guestAdvancedHelp') }}</div>
                </n-collapse-item>
              </n-collapse>
            </section>
          </template>

          <!-- ───────── sharing ───────── -->
          <template v-else-if="cat === 'share'">
            <section class="surface block">
              <h2>{{ t('settings.cat.share') }}</h2>
              <setting-row v-bind="rowProps('share.defaultDays')" :label="t('settings.share.defaultDays')" :help="t('settings.share.defaultDaysHelp')" @reset="reset('share.defaultDays')" @undo="undo('share.defaultDays')">
                <n-select v-model:value="f['share.defaultDays']" :options="dayOptions(true)" :disabled="off('share.defaultDays')" class="ctl" />
              </setting-row>
              <setting-row v-bind="rowProps('share.maxDays')" :label="t('settings.share.maxDays')" :help="t('settings.share.maxDaysHelp')" @reset="reset('share.maxDays')" @undo="undo('share.maxDays')">
                <n-select v-model:value="f['share.maxDays']" :options="dayOptions(false)" :disabled="off('share.maxDays')" class="ctl" />
              </setting-row>
              <setting-row v-bind="rowProps('share.allowNever')" :label="t('settings.share.allowNever')" :help="t('settings.share.allowNeverHelp')" @reset="reset('share.allowNever')" @undo="undo('share.allowNever')">
                <n-switch v-model:value="f['share.allowNever']" :disabled="off('share.allowNever')" />
              </setting-row>
              <setting-row v-bind="rowProps('share.requirePassword')" :label="t('settings.share.requirePassword')" :help="t('settings.share.requirePasswordHelp')" @reset="reset('share.requirePassword')" @undo="undo('share.requirePassword')">
                <n-switch v-model:value="f['share.requirePassword']" :disabled="off('share.requirePassword')" />
              </setting-row>
              <setting-row v-bind="rowProps('share.viewOnly')" :label="t('settings.share.viewOnly')" :help="t('settings.share.viewOnlyHelp')" @reset="reset('share.viewOnly')" @undo="undo('share.viewOnly')">
                <n-select v-model:value="f['share.viewOnly']" :options="viewOnlyOptions" :disabled="off('share.viewOnly')" class="ctl" />
              </setting-row>
              <setting-row v-bind="rowProps('share.forceWatermark')" :label="t('settings.share.forceWatermark')" :help="t('settings.share.forceWatermarkHelp')" @reset="reset('share.forceWatermark')" @undo="undo('share.forceWatermark')">
                <n-switch v-model:value="f['share.forceWatermark']" :disabled="off('share.forceWatermark')" />
              </setting-row>
            </section>
          </template>

          <!-- ───────── security ───────── -->
          <template v-else-if="cat === 'security'">
            <n-alert type="info" :show-icon="true" class="std">{{ t('settings.security.passwordNote') }}</n-alert>
            <section class="surface block">
              <h2>{{ t('settings.security.twoFactorTitle') }}</h2>
              <setting-row v-bind="rowProps('security.require2fa')" :label="t('settings.security.require2fa')" :help="t('settings.security.require2faHelp')" @reset="reset('security.require2fa')" @undo="undo('security.require2fa')">
                <n-select v-model:value="f['security.require2fa']" :options="require2faOptions" :disabled="off('security.require2fa')" class="ctl" data-tour="settings-require2fa" />
                <template #extra>
                  <n-alert v-if="warn2fa" type="warning" :show-icon="true" class="inline-warn">{{ t('settings.security.warn2fa') }}</n-alert>
                </template>
              </setting-row>
            </section>
            <section class="surface block">
              <h2>{{ t('settings.security.sessionTitle') }}</h2>
              <setting-row v-for="k in SECURITY_NUMBERS" :key="k" v-bind="rowProps(`security.${k}`)" :label="t(`settings.security.${k}`)" :help="t(`settings.security.${k}Help`, { min: RANGE[`security.${k}`][0], max: RANGE[`security.${k}`][1] })" @reset="reset(`security.${k}`)" @undo="undo(`security.${k}`)">
                <n-input-number v-model:value="f[`security.${k}`]" :min="RANGE[`security.${k}`][0]" :max="RANGE[`security.${k}`][1]" :precision="0" :show-button="false" :disabled="off(`security.${k}`)" class="ctl num" :input-props="{ inputmode: 'numeric' }">
                  <template #suffix>{{ t(`settings.unit.${UNIT[k]}`) }}</template>
                </n-input-number>
              </setting-row>
            </section>
          </template>

          <!-- ───────── files and storage ───────── -->
          <template v-else-if="cat === 'files'">
            <section class="surface block">
              <h2>{{ t('settings.files.uploadTitle') }}</h2>
              <setting-row v-bind="rowProps('files.uploadMaxSize')" :label="t('settings.files.uploadMaxSize')" :help="t('settings.files.uploadMaxSizeHelp', { max: formatBytes(srv.files.uploadMaxSizeCeiling) })" @reset="reset('files.uploadMaxSize')" @undo="undo('files.uploadMaxSize')">
                <size-input v-model="f['files.uploadMaxSize']" :disabled="off('files.uploadMaxSize')" :label="t('settings.files.uploadMaxSize')" />
              </setting-row>
              <setting-row v-bind="rowProps('files.defaultQuotaBytes')" :label="t('settings.files.defaultQuota')" :help="t('settings.files.defaultQuotaHelp')" @reset="reset('files.defaultQuotaBytes')" @undo="undo('files.defaultQuotaBytes')">
                <div class="quota">
                  <n-switch v-model:value="f.quotaUnlimited" :disabled="off('files.defaultQuotaBytes')">
                    <template #checked>{{ t('users.noLimit') }}</template><template #unchecked>{{ t('users.limited') }}</template>
                  </n-switch>
                  <size-input v-if="!f.quotaUnlimited" v-model="f['files.defaultQuotaBytes']" :disabled="off('files.defaultQuotaBytes')" :label="t('settings.files.defaultQuota')" />
                </div>
              </setting-row>
              <setting-row v-bind="rowProps('files.thumbnails')" :label="t('settings.files.thumbnails')" :help="t('settings.files.thumbnailsHelp')" @reset="reset('files.thumbnails')" @undo="undo('files.thumbnails')">
                <n-switch v-model:value="f['files.thumbnails']" :disabled="off('files.thumbnails')" />
              </setting-row>
              <setting-row v-bind="rowProps('files.webdav')" :label="t('settings.files.webdav')" :help="t('settings.files.webdavHelp')" @reset="reset('files.webdav')" @undo="undo('files.webdav')">
                <n-switch v-model:value="f['files.webdav']" :disabled="off('files.webdav')" />
              </setting-row>
            </section>
            <section class="surface block">
              <h2>{{ t('settings.files.keepTitle') }}</h2>
              <setting-row v-for="k in FILE_NUMBERS" :key="k" v-bind="rowProps(`files.${k}`)" :label="t(`settings.files.${k}`)" :help="t(`settings.files.${k}Help`, { min: RANGE[`files.${k}`][0], max: RANGE[`files.${k}`][1] })" @reset="reset(`files.${k}`)" @undo="undo(`files.${k}`)">
                <n-input-number v-model:value="f[`files.${k}`]" :min="RANGE[`files.${k}`][0]" :max="RANGE[`files.${k}`][1]" :precision="0" :show-button="false" :disabled="off(`files.${k}`)" class="ctl num" :input-props="{ inputmode: 'numeric' }">
                  <template #suffix>{{ t(`settings.unit.${UNIT[k]}`) }}</template>
                </n-input-number>
              </setting-row>
            </section>
          </template>

          <!-- ───────── e-mail and notifications ───────── -->
          <template v-else-if="cat === 'mail'">
            <section class="surface block" data-tour="settings-mail">
              <h2>{{ t('settings.mail.title') }}</h2>
              <div class="muted lead">{{ t('settings.mail.lead') }}</div>
              <n-alert v-if="mailLocked" type="info" :show-icon="false" class="lock-note">{{ t('settings.lockedNoteMail') }}</n-alert>
              <setting-row v-bind="rowProps('mail.host')" :label="t('settings.mail.host')" :help="t('settings.mail.hostHelp')" @reset="reset('mail.host')" @undo="undo('mail.host')">
                <n-input v-model:value="f['mail.host']" :disabled="off('mail.host')" placeholder="smtp.example.com" class="ctl" :input-props="{ autocomplete: 'off', autocapitalize: 'off', spellcheck: false }" />
              </setting-row>
              <setting-row v-bind="rowProps('mail.port')" :label="t('settings.mail.port')" :help="t('settings.mail.portHelp')" @reset="reset('mail.port')" @undo="undo('mail.port')">
                <n-input-number v-model:value="f['mail.port']" :min="1" :max="65535" :precision="0" :show-button="false" :disabled="off('mail.port')" class="ctl num" :input-props="{ inputmode: 'numeric' }" />
              </setting-row>
              <setting-row v-bind="rowProps('mail.secure')" :label="t('settings.mail.secure')" :help="t('settings.mail.secureHelp')" @reset="reset('mail.secure')" @undo="undo('mail.secure')">
                <n-select v-model:value="f['mail.secure']" :options="secureOptions" :disabled="off('mail.secure')" class="ctl" />
              </setting-row>
              <setting-row v-bind="rowProps('mail.user')" :label="t('settings.mail.user')" :help="t('settings.mail.userHelp')" @reset="reset('mail.user')" @undo="undo('mail.user')">
                <n-input v-model:value="f['mail.user']" :disabled="off('mail.user')" class="ctl" :input-props="{ autocomplete: 'off', autocapitalize: 'off', spellcheck: false }" />
              </setting-row>
              <setting-row v-bind="rowProps('mail.pass')" :label="t('settings.mail.pass')" :help="t('settings.mail.passHelp')" @reset="reset('mail.pass')" @undo="undo('mail.pass')">
                <n-input v-model:value="f['mail.pass']" type="password" show-password-on="click" :disabled="off('mail.pass')" :placeholder="srv.mail.passSet ? t('settings.mail.passSet') : ''" class="ctl" :input-props="{ autocomplete: 'new-password', name: 'smtp-secret' }" />
              </setting-row>
              <setting-row v-bind="rowProps('mail.from')" :label="t('settings.mail.from')" :help="t('settings.mail.fromHelp')" @reset="reset('mail.from')" @undo="undo('mail.from')">
                <n-input v-model:value="f['mail.from']" :disabled="off('mail.from')" placeholder="File Center <no-reply@example.com>" class="ctl wide" :input-props="{ autocomplete: 'off', spellcheck: false }" />
              </setting-row>
              <setting-row :label="t('settings.mail.test')" :help="t('settings.mail.testHelp')" :error="mailTestError">
                <div class="test-row">
                  <n-input v-model:value="testTo" :placeholder="t('settings.mail.testTo')" class="ctl" :input-props="{ type: 'email', inputmode: 'email', autocomplete: 'off', 'aria-label': t('settings.mail.testTo') }" @keyup.enter="sendMailTest" />
                  <n-button :loading="testing" :disabled="mailDirty" @click="sendMailTest"><template #icon><n-icon :component="PaperPlaneOutline" /></template>{{ t('settings.mail.testSend') }}</n-button>
                </div>
                <div v-if="mailDirty" class="muted help-s">{{ t('settings.mail.saveFirst') }}</div>
                <n-alert v-if="mailTestOk" type="success" closable class="inline-warn" @close="mailTestOk = false">{{ t('settings.mail.testOk') }}</n-alert>
              </setting-row>
            </section>

            <section class="surface block" data-tour="settings-alerts">
              <h2>{{ t('settings.alerts.title') }}</h2>
              <div class="muted lead">{{ t('settings.alerts.lead') }}</div>
              <setting-row v-bind="rowProps('alerts.webhookUrl')" :label="t('settings.alerts.webhookUrl')" :help="t('settings.alerts.webhookUrlHelp')" @reset="reset('alerts.webhookUrl')" @undo="undo('alerts.webhookUrl')">
                <n-input v-model:value="f['alerts.webhookUrl']" :disabled="off('alerts.webhookUrl')" :placeholder="srv.alerts.webhookUrl.value || 'https://…'" class="ctl wide" :input-props="{ autocomplete: 'off', spellcheck: false, name: 'hook-url' }" />
                <template #extra>
                  <div v-if="srv.alerts.webhookUrl.value" class="muted help-s mono wrapany">{{ t('settings.alerts.current') }} {{ srv.alerts.webhookUrl.value }}</div>
                </template>
              </setting-row>
              <setting-row v-bind="rowProps('alerts.kind')" :label="t('settings.alerts.kind')" :help="t('settings.alerts.kindHelp')" @reset="reset('alerts.kind')" @undo="undo('alerts.kind')">
                <n-select v-model:value="f['alerts.kind']" :options="kindOptions" :disabled="off('alerts.kind')" class="ctl" />
              </setting-row>
              <setting-row v-if="f['alerts.kind'] === 'telegram'" v-bind="rowProps('alerts.telegramChatId')" :label="t('settings.alerts.chatId')" :help="t('settings.alerts.chatIdHelp')" @reset="reset('alerts.telegramChatId')" @undo="undo('alerts.telegramChatId')">
                <n-input v-model:value="f['alerts.telegramChatId']" :disabled="off('alerts.telegramChatId')" class="ctl" :input-props="{ autocomplete: 'off' }" />
              </setting-row>
              <setting-row v-bind="rowProps('alerts.lang')" :label="t('settings.alerts.lang')" :help="t('settings.alerts.langHelp')" @reset="reset('alerts.lang')" @undo="undo('alerts.lang')">
                <n-select v-model:value="f['alerts.lang']" :options="langOptions" :disabled="off('alerts.lang')" class="ctl" />
              </setting-row>
            </section>
            <alerts-card :key="alertsKey" />

            <section class="surface block" data-tour="settings-audit-forward">
              <h2>{{ t('settings.auditForward.title') }}</h2>
              <div class="muted lead">{{ t('settings.auditForward.lead') }}</div>
              <setting-row v-bind="rowProps('auditForward.syslogHost')" :label="t('settings.auditForward.syslogHost')" :help="t('settings.auditForward.syslogHostHelp')" @reset="reset('auditForward.syslogHost')" @undo="undo('auditForward.syslogHost')">
                <n-input v-model:value="f['auditForward.syslogHost']" :disabled="off('auditForward.syslogHost')" placeholder="logs.example.com" class="ctl" :input-props="{ autocomplete: 'off', spellcheck: false, name: 'syslog-host' }" />
              </setting-row>
              <setting-row v-bind="rowProps('auditForward.syslogPort')" :label="t('settings.auditForward.syslogPort')" @reset="reset('auditForward.syslogPort')" @undo="undo('auditForward.syslogPort')">
                <n-input-number v-model:value="f['auditForward.syslogPort']" :min="1" :max="65535" :precision="0" :show-button="false" :disabled="off('auditForward.syslogPort')" class="ctl" />
              </setting-row>
              <setting-row v-bind="rowProps('auditForward.syslogProto')" :label="t('settings.auditForward.syslogProto')" :help="t('settings.auditForward.syslogProtoHelp')" @reset="reset('auditForward.syslogProto')" @undo="undo('auditForward.syslogProto')">
                <n-select v-model:value="f['auditForward.syslogProto']" :options="protoOptions" :disabled="off('auditForward.syslogProto')" class="ctl" />
              </setting-row>
              <setting-row v-bind="rowProps('auditForward.syslogFacility')" :label="t('settings.auditForward.syslogFacility')" :help="t('settings.auditForward.syslogFacilityHelp')" @reset="reset('auditForward.syslogFacility')" @undo="undo('auditForward.syslogFacility')">
                <n-input-number v-model:value="f['auditForward.syslogFacility']" :min="0" :max="23" :precision="0" :show-button="false" :disabled="off('auditForward.syslogFacility')" class="ctl" />
              </setting-row>
              <setting-row v-bind="rowProps('auditForward.webhookUrl')" :label="t('settings.auditForward.webhookUrl')" :help="t('settings.auditForward.webhookUrlHelp')" @reset="reset('auditForward.webhookUrl')" @undo="undo('auditForward.webhookUrl')">
                <n-input v-model:value="f['auditForward.webhookUrl']" :disabled="off('auditForward.webhookUrl')" :placeholder="srv.auditForward.webhookUrl.value || 'https://…'" class="ctl wide" :input-props="{ autocomplete: 'off', spellcheck: false, name: 'audit-hook-url' }" />
                <template #extra>
                  <div v-if="srv.auditForward.webhookUrl.value" class="muted help-s mono wrapany">{{ t('settings.alerts.current') }} {{ srv.auditForward.webhookUrl.value }}</div>
                </template>
              </setting-row>
              <setting-row v-bind="rowProps('auditForward.webhookSecret')" :label="t('settings.auditForward.webhookSecret')" :help="t('settings.auditForward.webhookSecretHelp')" @reset="reset('auditForward.webhookSecret')" @undo="undo('auditForward.webhookSecret')">
                <n-input v-model:value="f['auditForward.webhookSecret']" type="password" show-password-on="click" :disabled="off('auditForward.webhookSecret')" :placeholder="srv.auditForward.webhookSecretSet ? t('settings.mail.passSet') : ''" class="ctl" :input-props="{ autocomplete: 'new-password', name: 'audit-hook-secret' }" />
              </setting-row>
            </section>
          </template>

          <!-- ───────── virus scanning ───────── -->
          <template v-else-if="cat === 'antivirus'">
            <section class="surface block" data-tour="settings-antivirus">
              <h2>{{ t('settings.antivirus.title') }}</h2>
              <div class="muted lead">{{ t('settings.antivirus.lead') }}</div>
              <n-alert v-if="avLocked" type="info" :show-icon="false" class="lock-note">{{ t('settings.lockedNoteAv') }}</n-alert>
              <setting-row v-bind="rowProps('antivirus.enabled')" :label="t('settings.antivirus.enabled')" :help="t('settings.antivirus.enabledHelp')" @reset="reset('antivirus.enabled')" @undo="undo('antivirus.enabled')">
                <n-switch v-model:value="f['antivirus.enabled']" :disabled="off('antivirus.enabled')" />
              </setting-row>
              <setting-row v-bind="rowProps('antivirus.host')" :label="t('settings.antivirus.host')" :help="t('settings.antivirus.hostHelp')" @reset="reset('antivirus.host')" @undo="undo('antivirus.host')">
                <n-input v-model:value="f['antivirus.host']" :disabled="off('antivirus.host')" class="ctl" :input-props="{ autocomplete: 'off', spellcheck: false, name: 'clamd-host' }" />
              </setting-row>
              <setting-row v-bind="rowProps('antivirus.port')" :label="t('settings.antivirus.port')" @reset="reset('antivirus.port')" @undo="undo('antivirus.port')">
                <n-input-number v-model:value="f['antivirus.port']" :min="1" :max="65535" :precision="0" :show-button="false" :disabled="off('antivirus.port')" class="ctl" />
              </setting-row>
              <setting-row v-bind="rowProps('antivirus.timeoutSeconds')" :label="t('settings.antivirus.timeoutSeconds')" @reset="reset('antivirus.timeoutSeconds')" @undo="undo('antivirus.timeoutSeconds')">
                <n-input-number v-model:value="f['antivirus.timeoutSeconds']" :min="1" :max="600" :precision="0" :show-button="false" :disabled="off('antivirus.timeoutSeconds')" class="ctl"><template #suffix>{{ t('settings.unit.seconds') }}</template></n-input-number>
              </setting-row>
              <setting-row v-bind="rowProps('antivirus.maxScanMb')" :label="t('settings.antivirus.maxScanMb')" :help="t('settings.antivirus.maxScanMbHelp')" @reset="reset('antivirus.maxScanMb')" @undo="undo('antivirus.maxScanMb')">
                <n-input-number v-model:value="f['antivirus.maxScanMb']" :min="1" :max="4096" :precision="0" :show-button="false" :disabled="off('antivirus.maxScanMb')" class="ctl"><template #suffix>MB</template></n-input-number>
              </setting-row>
              <setting-row v-bind="rowProps('antivirus.onTooBigLinks')" :label="t('settings.antivirus.onTooBigLinks')" :help="t('settings.antivirus.onTooBigLinksHelp')" @reset="reset('antivirus.onTooBigLinks')" @undo="undo('antivirus.onTooBigLinks')">
                <n-select v-model:value="f['antivirus.onTooBigLinks']" :options="onErrorOptions" :disabled="off('antivirus.onTooBigLinks')" class="ctl" />
              </setting-row>
              <setting-row v-bind="rowProps('antivirus.onTooBigUsers')" :label="t('settings.antivirus.onTooBigUsers')" :help="t('settings.antivirus.onTooBigUsersHelp')" @reset="reset('antivirus.onTooBigUsers')" @undo="undo('antivirus.onTooBigUsers')">
                <n-select v-model:value="f['antivirus.onTooBigUsers']" :options="onErrorOptions" :disabled="off('antivirus.onTooBigUsers')" class="ctl" />
              </setting-row>
              <setting-row v-bind="rowProps('antivirus.onErrorLinks')" :label="t('settings.antivirus.onErrorLinks')" :help="t('settings.antivirus.onErrorLinksHelp')" @reset="reset('antivirus.onErrorLinks')" @undo="undo('antivirus.onErrorLinks')">
                <n-select v-model:value="f['antivirus.onErrorLinks']" :options="onErrorOptions" :disabled="off('antivirus.onErrorLinks')" class="ctl" />
              </setting-row>
              <setting-row v-bind="rowProps('antivirus.onErrorUsers')" :label="t('settings.antivirus.onErrorUsers')" :help="t('settings.antivirus.onErrorUsersHelp')" @reset="reset('antivirus.onErrorUsers')" @undo="undo('antivirus.onErrorUsers')">
                <n-select v-model:value="f['antivirus.onErrorUsers']" :options="onErrorOptions" :disabled="off('antivirus.onErrorUsers')" class="ctl" />
              </setting-row>
              <div class="av-test">
                <n-button :loading="avTesting" :disabled="avDirty" @click="sendAvTest"><template #icon><n-icon :component="BugOutline" /></template>{{ t('settings.antivirus.test') }}</n-button>
                <span class="muted help-s">{{ avDirty ? t('settings.antivirus.testDirty') : t('settings.antivirus.testHelp') }}</span>
              </div>
              <n-alert v-if="avResult" :type="avResult.ok ? 'success' : 'error'" :title="avResult.ok ? undefined : t('settings.antivirus.testFailed')" class="av-result" closable @close="avResult = null">
                {{ avResult.ok ? t('settings.antivirus.testOk', { signature: avResult.signature }) : avResult.message }}
              </n-alert>
            </section>
            <quarantine-card />
          </template>

          <!-- appears as soon as something is changed -->
          <div v-if="count" class="savebar" role="region" :aria-label="t('settings.unsavedBar')" data-tour="settings-save">
            <span class="savebar-text">{{ t('settings.unsaved', { n: count }) }}</span>
            <span class="savebar-actions">
              <n-button :disabled="saving" @click="discard">{{ t('settings.discard') }}</n-button>
              <n-button type="primary" :loading="saving" @click="save"><template #icon><n-icon :component="SaveOutline" /></template>{{ t('common.save') }}</n-button>
            </span>
          </div>
        </div>
      </div>
    </n-spin>

    <!-- security, mail, alerts, share-link rules, switching the public page on and rights for visitors to change files ask for the admin's password -->
    <n-modal v-model:show="pwOpen" preset="card" :title="t('settings.pwTitle')" style="width: min(420px, 94vw)" :mask-closable="!saving" :closable="!saving">
      <p class="muted pw-text">{{ t('settings.pwText') }}</p>
      <n-input v-model:value="pw" type="password" show-password-on="click" :placeholder="t('security.yourPassword')" :status="pwError ? 'error' : undefined" :input-props="{ autocomplete: 'current-password', 'aria-label': t('security.yourPassword') }" @keyup.enter="confirmPw" />
      <div v-if="pwError" class="err pw-err" role="alert">{{ pwError }}</div>
      <template #footer>
        <div class="foot">
          <n-button :disabled="saving" @click="pwOpen = false">{{ t('common.cancel') }}</n-button>
          <n-button type="primary" :loading="saving" :disabled="!pw" @click="confirmPw">{{ t('common.confirm') }}</n-button>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<script setup>
import PageHeader from '../components/PageHeader.vue'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { onBeforeRouteLeave } from 'vue-router'
import { NAlert, NButton, NCheckbox, NCollapse, NCollapseItem, NColorPicker, NIcon, NInput, NInputNumber, NModal, NSelect, NSpin, NSwitch, NUpload } from 'naive-ui'
import { BugOutline, ColorPaletteOutline, FolderOpenOutline, GlobeOutline, ImageOutline, LinkOutline, MailOutline, PaperPlaneOutline, SaveOutline, ShieldCheckmarkOutline } from '@vicons/ionicons5'
import { api } from '../api'
import AlertsCard from '../components/AlertsCard.vue'
import QuarantineCard from '../components/QuarantineCard.vue'
import SettingRow from '../components/SettingRow.vue'
import SizeInput from '../components/SizeInput.vue'
import { i18n } from '../i18n'
import { errorText, useFeedback } from '../composables'
import { useAppStore } from '../store'
import { formatBytes } from '../utils'

// what a visitor may be given: never `share`, the server refuses links from visitors whatever is set here
const BASIC = ['read', 'download', 'batchdownload']
const ADVANCED = ['write', 'upload', 'zip']
const presets = ['#2563eb', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#16a34a', '#0d9488', '#475569']
const CATS = [
  { id: 'general', icon: ColorPaletteOutline },
  { id: 'public', icon: GlobeOutline },
  { id: 'share', icon: LinkOutline },
  { id: 'security', icon: ShieldCheckmarkOutline },
  { id: 'files', icon: FolderOpenOutline },
  { id: 'mail', icon: MailOutline },
  { id: 'antivirus', icon: BugOutline },
]
const FLAT = ['appName', 'primaryColor', 'welcomeTitle', 'welcomeText', 'publicEmptyText', 'publicEnabled']
const SECURITY_NUMBERS = ['sessionTtlHours', 'loginMaxAttempts', 'loginLockoutSeconds']
const FILE_NUMBERS = ['trashRetentionDays', 'versionsKeep', 'versionsDays']
// the same limits as the server (src/policy.ts)
const RANGE = {
  'security.sessionTtlHours': [1, 2160], 'security.loginMaxAttempts': [3, 20], 'security.loginLockoutSeconds': [30, 3600],
  'files.trashRetentionDays': [1, 365], 'files.versionsKeep': [0, 100], 'files.versionsDays': [1, 365], 'mail.port': [1, 65535],
  'auditForward.syslogPort': [1, 65535], 'auditForward.syslogFacility': [0, 23],
  'antivirus.port': [1, 65535], 'antivirus.timeoutSeconds': [1, 600], 'antivirus.maxScanMb': [1, 4096],
}
const UNIT = { sessionTtlHours: 'hours', loginMaxAttempts: 'times', loginLockoutSeconds: 'seconds', trashRetentionDays: 'days', versionsKeep: 'versions', versionsDays: 'days' }
// the settings that live in a group of the server's answer (path = group.key), and which category shows each
const GROUPED = {
  share: ['defaultDays', 'maxDays', 'allowNever', 'requirePassword', 'viewOnly', 'forceWatermark'],
  security: ['require2fa', ...SECURITY_NUMBERS],
  files: ['uploadMaxSize', 'defaultQuotaBytes', 'thumbnails', 'webdav', ...FILE_NUMBERS],
  mail: ['host', 'port', 'secure', 'user', 'pass', 'from'],
  alerts: ['webhookUrl', 'kind', 'telegramChatId', 'lang'],
  auditForward: ['syslogHost', 'syslogPort', 'syslogProto', 'syslogFacility', 'webhookUrl', 'webhookSecret'],
  antivirus: ['enabled', 'host', 'port', 'timeoutSeconds', 'maxScanMb', 'onTooBigLinks', 'onTooBigUsers', 'onErrorLinks', 'onErrorUsers'],
}
const CAT_OF = { appName: 'general', primaryColor: 'general', guestPermissions: 'public', welcomeTitle: 'public', welcomeText: 'public', publicEmptyText: 'public', publicEnabled: 'public', share: 'share', security: 'security', files: 'files', mail: 'mail', alerts: 'mail', auditForward: 'mail', antivirus: 'antivirus' }
const catOfPath = p => CAT_OF[p.includes('.') ? p.split('.')[0] : p]
// never shown back: a blank box means "keep what is there"
const WRITE_ONLY = ['mail.pass', 'alerts.webhookUrl', 'auditForward.webhookUrl', 'auditForward.webhookSecret']
const ALL_PATHS = [...FLAT, 'guestPermissions', ...Object.entries(GROUPED).flatMap(([g, ks]) => ks.map(k => `${g}.${k}`))]

const { t } = useI18n()
const app = useAppStore()
const fb = useFeedback()
const loading = ref(false)
const saving = ref(false)
const ready = ref(false)
const cat = ref('general')
const srv = ref(null)
const f = reactive({})
let orig = {}
const resets = ref([])
const serverErrors = ref({})
const advOpen = ref([])
const alertsKey = ref(0)
const pwOpen = ref(false)
const pw = ref('')
const pwError = ref('')
const testTo = ref('')
const testing = ref(false)
const mailTestOk = ref(false)
const mailTestError = ref('')

const catOptions = computed(() => CATS.map(c => ({ value: c.id, label: t(`settings.cat.${c.id}`) + (countOf(c.id) ? ` (${countOf(c.id)})` : '') })))
const secureOptions = computed(() => ['starttls', 'tls', 'none'].map(v => ({ value: v, label: t(`settings.mail.secure_${v}`) })))
const kindOptions = computed(() => ['discord', 'slack', 'telegram', 'json'].map(v => ({ value: v, label: t(`alerts.webhooks.${v}`) })))
const protoOptions = [{ value: 'udp', label: 'UDP' }, { value: 'tcp', label: 'TCP' }]
const viewOnlyOptions = computed(() => ['allow', 'force', 'forbid'].map(v => ({ value: v, label: t(`settings.share.viewOnly_${v}`) })))
const onErrorOptions = computed(() => ['reject', 'allow'].map(v => ({ value: v, label: t(`settings.antivirus.${v}`) })))
const langOptions = [{ value: 'th', label: 'ไทย' }, { value: 'en', label: 'English' }]
const require2faOptions = computed(() => ['none', 'admin', 'staff', 'all'].map(v => ({ value: v, label: t(`settings.security.require_${v}`) })))
function dayOptions(forDefault) {
  const max = f['share.maxDays']
  return (srv.value?.share.choices || []).map(d => ({ value: d, label: t('share.days', d), disabled: forDefault && d > max }))
}

// older versions stored the Thai standard text itself; the server treats it as "standard" (it follows the language), so show it as empty
const own = (v, key) => (v === i18n.global.getLocaleMessage('th').settings[key] ? '' : v || '')

/** the value of every setting as the server tells it: the starting point of the form */
function valuesOf(s) {
  const v = {
    appName: s.appName, primaryColor: s.primaryColor, publicEnabled: s.publicEnabled,
    welcomeTitle: own(s.welcomeTitle, 'stdWelcomeTitle'), welcomeText: own(s.welcomeText, 'stdWelcomeText'), publicEmptyText: own(s.publicEmptyText, 'stdEmptyText'),
    guestPermissions: [...s.guestPermissions],
  }
  for (const [g, keys] of Object.entries(GROUPED)) {
    for (const k of keys) v[`${g}.${k}`] = WRITE_ONLY.includes(`${g}.${k}`) ? '' : s[g][k].value
  }
  v.quotaUnlimited = !s.files.defaultQuotaBytes.value
  v['files.defaultQuotaBytes'] = s.files.defaultQuotaBytes.value
  return v
}
function fill(s) {
  srv.value = s
  const v = valuesOf(s)
  for (const k of Object.keys(f)) delete f[k]
  Object.assign(f, v)
  orig = JSON.parse(JSON.stringify(v))
  resets.value = []
  serverErrors.value = {}
  advOpen.value = ADVANCED.some(p => v.guestPermissions.includes(p)) ? ['adv'] : []
}

const sourceOf = p => {
  if (!srv.value || !p.includes('.')) return ''
  const [g, k] = p.split('.')
  if (p === 'mail.pass') return srv.value.mail.passSource
  if (p === 'auditForward.webhookSecret') return srv.value.auditForward.webhookSecretSource
  return srv.value[g][k]?.source || ''
}
// LOCK_OUTBOUND_SETTINGS: the server marks these `locked`; they show the .env value read-only and are never sent
const isLocked = p => {
  if (!srv.value || !p.includes('.')) return false
  const [g, k] = p.split('.')
  if (p === 'mail.pass') return !!srv.value.mail.passLocked
  if (p === 'auditForward.webhookSecret') return !!srv.value.auditForward.webhookSecretLocked
  return !!srv.value[g][k]?.locked
}
const lockedIn = prefix => computed(() => ready.value && ALL_PATHS.some(p => prefix.some(x => p.startsWith(x)) && isLocked(p)))
const mailLocked = lockedIn(['mail.', 'alerts.', 'auditForward.'])
const avLocked = lockedIn(['antivirus.'])
const off = p => resets.value.includes(p) || isLocked(p)
const same = (a, b) => (Array.isArray(a) ? [...a].sort().join() === [...b].sort().join() : a === b)
function isChanged(p) {
  if (isLocked(p)) return false
  if (resets.value.includes(p)) return true
  if (WRITE_ONLY.includes(p)) return f[p] !== ''
  if (p === 'files.defaultQuotaBytes') return f.quotaUnlimited !== orig.quotaUnlimited || (!f.quotaUnlimited && f[p] !== orig[p])
  return !same(f[p], orig[p])
}
const changedPaths = computed(() => (ready.value ? ALL_PATHS.filter(isChanged) : []))
const count = computed(() => changedPaths.value.length)
const countOf = id => changedPaths.value.filter(p => catOfPath(p) === id).length
const mailDirty = computed(() => changedPaths.value.some(p => p.startsWith('mail.')))
const avDirty = computed(() => changedPaths.value.some(p => p.startsWith('antivirus.')))

const reset = p => { if (!resets.value.includes(p)) resets.value.push(p) }
const undo = p => { resets.value = resets.value.filter(x => x !== p) }

// field-level problems the page can see itself (the server checks the same again)
const bytesText = n => formatBytes(n)
function localError(p) {
  if (!ready.value || off(p)) return ''
  const r = RANGE[p]
  if (r) {
    const v = f[p]
    if (v === null || v === undefined || v < r[0] || v > r[1]) return t('settings.range', { min: r[0], max: r[1] })
  }
  if (p === 'share.defaultDays' && f[p] > f['share.maxDays']) return t('settings.share.defaultTooLong', { n: f['share.maxDays'] })
  if (p === 'files.uploadMaxSize' && f[p] > srv.value.files.uploadMaxSizeCeiling) return t('settings.files.overCeiling', { max: bytesText(srv.value.files.uploadMaxSizeCeiling) })
  if (p === 'files.uploadMaxSize' && !f[p]) return t('settings.required')
  if (p === 'files.defaultQuotaBytes' && !f.quotaUnlimited && !f[p]) return t('settings.required')
  if (p === 'mail.port' && !f[p]) return t('settings.required')
  if (p === 'auditForward.syslogPort' && !f[p]) return t('settings.required')
  if ((p === 'antivirus.port' || p === 'antivirus.timeoutSeconds' || p === 'antivirus.maxScanMb') && !f[p]) return t('settings.required')
  if (p === 'antivirus.host' && !String(f[p] || '').trim()) return t('settings.required')
  return ''
}
const errorOf = p => serverErrors.value[p] || localError(p)
const rowProps = p => ({ source: sourceOf(p), error: errorOf(p), changed: isChanged(p), resetting: resets.value.includes(p) })
const hasErrors = computed(() => ready.value && ALL_PATHS.some(p => p.includes('.') && errorOf(p)))

const hasPerm = k => f.guestPermissions.includes(k)
function setPerm(k, on) {
  const list = f.guestPermissions.filter(p => p !== k)
  f.guestPermissions = on ? [...list, k] : list
}

// the admin asking 2FA of the role they hold themself, without having it on
const covers = { none: [], admin: ['admin'], staff: ['admin', 'manager'], all: ['admin', 'manager', 'user'] }
const warn2fa = computed(() => ready.value && isChanged('security.require2fa') && !resets.value.includes('security.require2fa') && !app.user?.twoFactor && (covers[f['security.require2fa']] || []).includes(app.user?.role))

// ───────── save ─────────
const needsPassword = computed(() => changedPaths.value.some(p => p.startsWith('security.') || p.startsWith('mail.') || p.startsWith('alerts.') || p.startsWith('auditForward.') || p.startsWith('antivirus.') || p.startsWith('share.'))
  || (f.publicEnabled && !orig.publicEnabled)
  || ADVANCED.some(p => hasPerm(p) && !orig.guestPermissions.includes(p)))

function toApi(p) {
  if (p === 'files.defaultQuotaBytes') return f.quotaUnlimited ? 0 : f[p]
  return f[p]
}
function buildBody() {
  const body = {}
  for (const p of changedPaths.value) {
    if (!p.includes('.')) { body[p] = f[p]; continue }
    const [g, k] = p.split('.')
    ;(body[g] ??= {})[k] = resets.value.includes(p) ? null : toApi(p)
  }
  return body
}

async function save() {
  if (saving.value || !count.value) return
  serverErrors.value = {}
  if (hasErrors.value) {
    const first = ALL_PATHS.find(p => p.includes('.') && errorOf(p))
    cat.value = catOfPath(first)
    return fb.fail(null, t('settings.fixErrors'))
  }
  if (warn2fa.value && !(await fb.confirm({ title: t('settings.security.warn2faTitle'), content: t('settings.security.warn2faConfirm'), positive: t('settings.security.warn2faYes'), danger: true }))) return
  if (needsPassword.value) { pw.value = ''; pwError.value = ''; pwOpen.value = true; return }
  await send('')
}
const confirmPw = () => { if (pw.value) send(pw.value) }

async function send(password) {
  saving.value = true
  try {
    const body = buildBody()
    if (password) body.password = password
    const s = await api.saveSettings(body)
    pwOpen.value = false
    pw.value = ''
    fill(s)
    alertsKey.value++
    await app.refresh()
    fb.ok(t('common.saved'))
  } catch (e) {
    if (e.code === 'auth.wrong-password') {
      // asked for although the page thought it was not needed: ask now; or wrong: say so and ask again
      pwError.value = password ? errorText(e) : ''
      pw.value = ''
      pwOpen.value = true
    } else if (e.code === 'admin.bad-setting' && e.params?.key) {
      pwOpen.value = false
      const p = e.params.key
      serverErrors.value = { [p]: e.params.min !== undefined ? t('settings.range', { min: e.params.min, max: e.params.max }) : t('settings.badValue') }
      if (p === 'share.defaultDays' && e.params.max) serverErrors.value[p] = t('settings.share.defaultTooLong', { n: e.params.max })
      cat.value = catOfPath(p)
    } else if (e.code === 'admin.setting-locked') {
      // the lock was switched on after this page loaded: reload so locked rows turn read-only, keep the edits that are still allowed
      pwOpen.value = false
      const kept = changedPaths.value.map(p => [p, f[p]])
      const keptResets = [...resets.value]
      const keptUnlimited = f.quotaUnlimited
      try {
        fill(await api.settings())
        for (const [p, v] of kept) if (!isLocked(p)) f[p] = v
        // fill() forgets the reset-to-default marks and the quota switch: they are edits too
        resets.value = keptResets.filter(p => !isLocked(p))
        f.quotaUnlimited = keptUnlimited
      } catch { /* the message below still tells what happened; the page keeps its unsaved edits */ }
      fb.fail(e)
    } else if (e.code === 'admin.upload-over-ceiling') {
      pwOpen.value = false
      serverErrors.value = { 'files.uploadMaxSize': t('settings.files.overCeiling', { max: bytesText(e.params?.max ?? srv.value.files.uploadMaxSizeCeiling) }) }
      cat.value = 'files'
    } else { pwOpen.value = false; fb.fail(e) }
  } finally { saving.value = false }
}

function discard() { fill(srv.value) }

async function load() {
  loading.value = true
  try {
    fill(await api.settings())
    ready.value = true
  } catch (e) { fb.fail(e) } finally { loading.value = false }
}

async function sendMailTest() {
  if (testing.value || mailDirty.value) return
  testing.value = true
  mailTestOk.value = false
  mailTestError.value = ''
  try {
    await api.mailTest(testTo.value.trim())
    mailTestOk.value = true
  } catch (e) { mailTestError.value = errorText(e, t('common.unknownError')) } finally { testing.value = false }
}

const avTesting = ref(false)
const avResult = ref(null)
async function sendAvTest() {
  if (avTesting.value || avDirty.value) return
  avTesting.value = true
  avResult.value = null
  try {
    const r = await api.antivirusTest()
    avResult.value = { ok: true, signature: r.signature }
  } catch (e) { avResult.value = { ok: false, message: errorText(e, t('common.unknownError')) } } finally { avTesting.value = false }
}

async function onLogo({ file }) {
  try { await api.uploadLogo(file.file); await app.refresh(); fb.ok(t('common.saved')) } catch (e) { fb.fail(e) }
  return false
}
async function removeLogo() {
  try { await api.removeLogo(); await app.refresh() } catch (e) { fb.fail(e) }
}

// a field the server flagged is fine again once its value moves
watch(f, () => { if (Object.keys(serverErrors.value).length) serverErrors.value = {} }, { deep: true })
// nothing is lost by accident: leaving the page, closing the tab
onBeforeRouteLeave(async () => {
  if (!count.value) return true
  return fb.confirm({ title: t('settings.leaveTitle'), content: t('settings.leaveText', { n: count.value }), positive: t('settings.leaveYes'), danger: true })
})
const beforeUnload = e => { if (count.value) { e.preventDefault(); e.returnValue = '' } }
onMounted(() => { load(); window.addEventListener('beforeunload', beforeUnload) })
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload))
</script>

<style scoped>
.settings { max-width: 1080px; }
.layout { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 24px; align-items: start; }
.cats { position: sticky; top: calc(var(--header-h) + 16px); }
.cat-nav { display: flex; flex-direction: column; gap: 2px; }
.cat { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 8px; cursor: pointer; font-size: 14.5px; color: var(--text); }
.cat:hover, .cat:focus-visible { background: var(--surface-2); }
.cat:focus-visible { outline: 2px solid var(--primary); }
.cat.on { background: var(--primary-soft); color: var(--primary); font-weight: 600; }
.cat-label { min-width: 0; flex: 1; overflow-wrap: anywhere; }
.cat-count { flex: none; min-width: 20px; padding: 0 6px; height: 20px; line-height: 20px; border-radius: 10px; background: var(--primary); color: #fff; font-size: 12px; text-align: center; }
.cat-select { display: none; }
.content { min-width: 0; }
.block { padding: 22px; margin-bottom: 16px; }
.block h2 { margin: 0 0 16px; font-size: 16px; font-weight: 600; }
.lead { font-size: 13px; line-height: 1.6; margin: -8px 0 14px; overflow-wrap: anywhere; }
.lock-note { margin-bottom: 14px; }
.ctl { width: 100%; max-width: 320px; }
.av-test { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 16px; }
.av-test .help-s { margin-top: 0; }
.av-result { margin-top: 12px; }
.ctl.wide { max-width: 560px; }
.ctl.num { max-width: 200px; }
.colors { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.swatch { width: 28px; height: 28px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; padding: 0; outline: 1px solid var(--border); }
.swatch.on { border-color: var(--surface); outline: 2px solid var(--text); }
.logo-field { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; width: 100%; min-width: 0; }
.logo-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
/* n-upload is as wide as its parent by default, which pushed "remove" onto a line of its own */
.logo-upload { width: auto; }
.logo-prev { max-height: 48px; max-width: 180px; min-width: 48px; min-height: 32px; object-fit: contain; padding: 4px; border: 1px solid var(--border); border-radius: 8px; background: #fff; }
.std { margin-bottom: 16px; }
.perms { display: flex; flex-wrap: wrap; gap: 8px 18px; }
.adv { margin-top: 6px; border-top: 1px solid var(--border); padding-top: 4px; }
.adv-warn { margin-bottom: 12px; }
.help-s { font-size: 12.5px; line-height: 1.55; margin-top: 8px; overflow-wrap: anywhere; }
.wrapany { overflow-wrap: anywhere; }
.inline-warn { margin-top: 10px; }
.quota { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; }
.test-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.test-row .ctl { flex: 1 1 200px; }
.kv { display: flex; justify-content: space-between; padding: 8px 0; font-size: 14px; }
.pw-text { margin: 0 0 12px; font-size: 13.5px; line-height: 1.6; }
.pw-err, .err { color: var(--danger); font-size: 12.5px; margin-top: 8px; }
.foot { display: flex; justify-content: flex-end; gap: 8px; }

/* the save bar sticks to the bottom of the window while there is something to save */
.savebar {
  position: sticky; bottom: 12px; z-index: 20; display: flex; align-items: center; justify-content: space-between; gap: 10px 16px; flex-wrap: wrap;
  padding: 12px 16px; background: var(--surface); border: 1px solid var(--primary); border-radius: var(--radius); box-shadow: 0 6px 24px rgba(16, 24, 40, 0.18);
}
.savebar-text { font-size: 14px; font-weight: 600; }
.savebar-actions { display: flex; gap: 8px; margin-left: auto; }

@media (max-width: 960px) {
  .layout { grid-template-columns: minmax(0, 1fr); gap: 14px; }
  .cats { position: static; }
  .cat-nav { display: none; }
  .cat-select { display: block; width: 100%; }
}
@media (max-width: 480px) {
  .block { padding: 16px; }
  .savebar { padding: 10px 12px; bottom: 8px; }
  .savebar-actions { width: 100%; }
  .savebar-actions .n-button { flex: 1; }
}
</style>
