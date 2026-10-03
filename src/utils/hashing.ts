import argon2 from 'argon2';
export const hashPassword = (password: string) =>
  argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  });
export const verifyPassword = (hash: string, password: string) =>
  argon2.verify(hash, password);
