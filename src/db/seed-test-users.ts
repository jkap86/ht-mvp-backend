import bcrypt from 'bcrypt';
import { pool, closePool } from './pool';

const TEST_PASSWORD = 'password';
const NUM_USERS = 12;

async function seedTestUsers() {
  console.log('🌱 Seeding test users...\n');

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);

  for (let i = 1; i <= NUM_USERS; i++) {
    const username = `test${i}`;
    const email = `test${i}@example.com`;

    try {
      // Check if user already exists
      const existing = await pool.query(
        'SELECT id FROM users WHERE username = $1',
        [username]
      );

      if (existing.rows.length > 0) {
        console.log(`  ⏭️  ${username} already exists, skipping`);
        continue;
      }

      // Create user
      await pool.query(
        `INSERT INTO users (username, email, password_hash)
         VALUES ($1, $2, $3)`,
        [username, email, passwordHash]
      );

      console.log(`  ✅ Created ${username}`);
    } catch (error: any) {
      console.error(`  ❌ Failed to create ${username}: ${error.message}`);
    }
  }

  console.log('\n✨ Done! All test users have password: "password"');
}

// Run the seed
seedTestUsers()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
