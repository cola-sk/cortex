/**
 * JavaScript 原型继承 - 简单版
 *
 * 核心概念：
 *   每个函数都有 prototype 属性（一个对象）
 *   每个对象都有 __proto__ 属性（指向创建它的构造函数的 prototype）
 *   查找属性时，沿着 __proto__ 链向上查找，直到 null
 */

// ============================================================
// 第一步：继承工具函数 —— 核心就两行
// ============================================================

/**
 * 让 Child 继承 Parent
 * @param {Function} Child  - 子类构造函数
 * @param {Function} Parent - 父类构造函数
 */
function inherit(Child, Parent) {
    // 1. 子类的 prototype 指向父类 prototype 的副本，形成原型链
    Child.prototype = Object.create(Parent.prototype);
    // 2. 修复 constructor 指向（否则 constructor 会指向 Parent）
    Child.prototype.constructor = Child;
}

// ============================================================
// 第二步：父类 Animal
// ============================================================

function Animal(name, age) {
    // 实例属性：每个对象独有
    this.name = name;
    this.age = age;
}

// 原型方法：所有实例共享
Animal.prototype.speak = function () {
    console.log(`${this.name} 在叫`);
};

Animal.prototype.info = function () {
    console.log(`名字: ${this.name}, 年龄: ${this.age}`);
};

// ============================================================
// 第三步：子类 Dog 继承 Animal
// ============================================================

function Dog(name, age, breed) {
    // ① 调用父类构造函数，初始化继承来的实例属性
    Animal.call(this, name, age);
    // ② 自己的实例属性
    this.breed = breed;
}

// 建立原型链继承
inherit(Dog, Animal);

// 子类自己的原型方法
Dog.prototype.bark = function () {
    console.log(`${this.name} 汪汪汪！`);
};

Dog.prototype.fetch = function (thing) {
    console.log(`${this.name} 去捡 ${thing}`);
};

// ============================================================
// 第四步：子类 Cat 也继承 Animal
// ============================================================

function Cat(name, age, color) {
    Animal.call(this, name, age);
    this.color = color;
}

inherit(Cat, Animal);

Cat.prototype.meow = function () {
    console.log(`${this.name} 喵喵喵～`);
};

// ============================================================
// 第五步：孙类 —— 继承的继承
// ============================================================

function Husky(name, age) {
    Dog.call(this, name, age, '哈士奇');
}

inherit(Husky, Dog); // Husky → Dog → Animal → Object → null

Husky.prototype.talk = function () {
    console.log(`${this.name}: 哦哦哦哦～`); // 哈士奇会"说话"
};

// ============================================================
// 测试
// ============================================================

console.log('========== 原型链测试 ==========\n');

// --- Dog 测试 ---
const dog = new Dog('旺财', 3, '中华田园犬');
dog.speak();    // 继承自 Animal
dog.info();     // 继承自 Animal
dog.bark();     // Dog 自有
dog.fetch('球'); // Dog 自有

console.log('\n--- instanceof 检查 ---');
console.log(dog instanceof Dog);     // true
console.log(dog instanceof Animal);  // true（原型链上）
console.log(dog instanceof Cat);     // false

console.log('\n--- constructor 检查 ---');
console.log(dog.constructor === Dog);       // true（已修复）
console.log(dog.constructor === Animal);    // false

// --- Cat 测试 ---
console.log('\n========== Cat 测试 ==========');
const cat = new Cat('咪咪', 2, '橘色');
cat.speak();
cat.info();
cat.meow();

console.log(cat instanceof Animal); // true

// --- Husky（孙类）测试 ---
console.log('\n========== Husky 孙类测试 ==========');
const husky = new Husky('二哈', 4);
husky.speak();    // Animal
husky.bark();     // Dog
husky.talk();     // Husky

console.log('\n--- Husky instanceof ---');
console.log(husky instanceof Husky);   // true
console.log(husky instanceof Dog);     // true
console.log(husky instanceof Animal);  // true
console.log(husky instanceof Cat);     // false

// --- 原型链可视化 ---
console.log('\n========== 原型链 ==========\n');
console.log(
    'Husky 原型链:',
    Husky.prototype.__proto__ === Dog.prototype,     // true
    Dog.prototype.__proto__ === Animal.prototype,    // true
    Animal.prototype.__proto__ === Object.prototype, // true
    Object.prototype.__proto__ === null              // true
);

console.log('\n完整链: Husky → Dog → Animal → Object → null');
