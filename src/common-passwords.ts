/**
 * The 100 most common passwords (SecLists, Passwords/Common-Credentials/10-million-password-list-top-100.txt),
 * as published. Most are shorter than the minimum length and are refused for that already; the list catches the
 * long ones and keeps the rule honest if the minimum is ever lowered.
 */
const TOP_100 = [
  '123456', 'password', '12345678', 'qwerty', '123456789', '12345', '1234', '111111', '1234567', 'dragon',
  '123123', 'baseball', 'abc123', 'football', 'monkey', 'letmein', '696969', 'shadow', 'master', '666666',
  'qwertyuiop', '123321', 'mustang', '1234567890', 'michael', '654321', 'pussy', 'superman', '1qaz2wsx', '7777777',
  'fuckyou', '121212', '000000', 'qazwsx', '123qwe', 'killer', 'trustno1', 'jordan', 'jennifer', 'zxcvbnm',
  'asdfgh', 'hunter', 'buster', 'soccer', 'harley', 'batman', 'andrew', 'tigger', 'sunshine', 'iloveyou',
  'fuckme', '2000', 'charlie', 'robert', 'thomas', 'hockey', 'ranger', 'daniel', 'starwars', 'klaster',
  '112233', 'george', 'asshole', 'computer', 'michelle', 'jessica', 'pepper', '1111', 'zxcvbn', '555555',
  '11111111', '131313', 'freedom', '777777', 'pass', 'fuck', 'maggie', '159753', 'aaaaaa', 'ginger',
  'princess', 'joshua', 'cheese', 'amanda', 'summer', 'love', 'ashley', '6969', 'nicole', 'chelsea',
  'biteme', 'matthew', 'access', 'yankees', '987654321', 'dallas', 'austin', 'thunder', 'taylor', 'matrix',
]

/**
 * Common passwords of 10 or more characters, the ones the minimum length lets through: picked from public breach
 * lists (RockYou, the SecLists common-credential lists, password-spraying lists), lowercase. One repeated character
 * and straight keyboard or number runs are refused by isRunOrRepeat() instead, so they are not listed here.
 */
const LONG = [
  // password + digits or symbols
  'password12', 'password123', 'password1234', 'password12345', 'password01', 'password11', 'password1!',
  'password@123', 'p@ssw0rd123', 'p@ssword123', 'passw0rd123', 'password2020', 'password2021', 'password2022',
  'password2023', 'password2024', 'password2025', 'passwordpassword', 'mypassword', 'mypassword1', 'mypassword123',
  'newpassword', 'nopassword', 'yourpassword', 'secretpassword',
  // keyboard patterns with a twist
  '1q2w3e4r5t', '1q2w3e4r5t6y', 'q1w2e3r4t5', 'q1w2e3r4t5y6', '1qaz2wsx3edc', '1qaz2wsx3edc4rfv', 'qazwsxedcrfv',
  'qazwsxedc123', 'qweasdzxc123', '123qweasdzxc', 'zaq12wsxcde3', 'qwerty1234', 'qwerty12345', 'qwerty123456',
  'qwerty123!', 'qwertyuiop1', 'qwertyuiop123', 'asdfghjkl1', 'asdfghjkl123', 'zxcvbnm123', 'zxcvbnm1234',
  'azertyuiop', 'qwertzuiop', 'asdf123456', 'qwe123qwe123',
  // digits
  '12345678910', '1234567891', '1234567899', '123456789a', 'a123456789', 'q123456789', '123456789q',
  '123456abcd', 'abcd123456', 'abc1234567', 'abcdefg123', 'abcdef1234', 'aa12345678', 'qq12345678',
  '1234512345', '1122334455', '1212121212', '1231231231', '123123123123', '123456123456', '123456789123',
  '1234554321', '5201314520', '1314520520',
  // words with digits
  'iloveyou12', 'iloveyou123', 'iloveyou1234', 'iloveyou143', 'administrator', 'admin12345', 'admin123456',
  'adminadmin', 'admin@1234', 'welcome123', 'welcome1234', 'welcome@123', 'welcome2024', 'changeme123',
  'changeme12', 'letmein123', 'test123456', 'testing123', 'user123456', 'root123456', 'default123',
  'master1234', 'basketball', 'football123', 'baseball123', 'chocolate1', 'butterfly1', 'liverpool1',
  'liverpool123', 'pokemon123', 'samsung123', 'princess123', 'sunshine123', 'superman123', 'starwars123',
  'computer123', 'monkey1234', 'dragon1234', 'summer2023', 'summer2024', 'winter2024', 'spring2024',
]

export const COMMON_PASSWORDS = new Set([...TOP_100, ...LONG])

// keyboard rows and the alphabet; a password that is a stretch of one of these, either way, is a "straight run"
const RUNS = [
  '`1234567890-=', '01234567890','abcdefghijklmnopqrstuvwxyz',
  'qwertyuiop[]\\', "asdfghjkl;'", 'zxcvbnm,./', 'qwertyuiopasdfghjklzxcvbnm',
]

/** `lower` (already lowercased) is one character over and over, or a straight run of keyboard/number/abc order */
export function isRunOrRepeat(lower: string): boolean {
  if (!lower) return false
  if (new Set(lower).size === 1) return true
  const reversed = [...lower].reverse().join('')
  return RUNS.some(run => run.includes(lower) || run.includes(reversed))
}
