import { assert, expect } from "chai";
import { ethers } from "hardhat";
import { MockContract } from "ethereum-waffle";
import { deployMock } from "./utils/deploy";
import { CashierTest } from "../typechain-types";
import { increaseTime, Snapshot } from "./utils/snapshot";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";

const KB: number = 1024;
const MB: number = 1024 * KB;
const GB: number = 1024 * MB;
const TB: number = 1024 * GB;
const BYTES_PER_SECTOR = 256;
const BASIC_PRICE = 1000;
const UPLOAD_TOKEN_PER_SECTOR: bigint = BigInt(10) ** BigInt(18);

describe.only("Cashier", async function () {
  let mockCoupon: MockContract;
  let mockUploadToken: MockContract;
  let mockZgsToken: MockContract;
  let cashier: CashierTest;
  let snapshot: Snapshot;
  let owner: SignerWithAddress;
  let mockMine: SignerWithAddress;
  let mockFlow: SignerWithAddress;
  let mockStake: SignerWithAddress;

  before(async () => {
    [owner, mockMine, mockFlow, mockStake] = await ethers.getSigners();

    mockCoupon = await deployMock(owner, "Coupon");
    mockUploadToken = await deployMock(owner, "UploadToken");
    mockZgsToken = await deployMock(owner, "MockToken");

    let cashierABI = await ethers.getContractFactory("CashierTest");
    cashier = await cashierABI.deploy(
      mockZgsToken.address,
      mockUploadToken.address,
      mockFlow.address,
      mockMine.address,
      mockStake.address
    );

    snapshot = await new Snapshot().snapshot();
  });

  beforeEach(async () => {
    await snapshot.revert();
  });

  describe("Test Gauge Drip", async () => {
    it("Normal case", async () => {
      await cashier.updateTotalSubmission((3 * TB) / BYTES_PER_SECTOR);
      let beforeGauge = (await cashier.gauge()).toBigInt();
      await increaseTime(100);
      await cashier.updateGauge();
      let afterGauge = (await cashier.gauge()).toBigInt();
      assert(
        afterGauge - beforeGauge == BigInt(300 * MB),
        "Incorrect gauge delta"
      );
    });

    it("Upper bound capped", async () => {
      await cashier.updateTotalSubmission((3 * TB) / BYTES_PER_SECTOR);
      await increaseTime(20000);
      await cashier.updateGauge();
      let afterGauge = (await cashier.gauge()).toBigInt();
      assert(afterGauge == BigInt(30 * GB));
    });

    it("Small dripping rate", async () => {
      await cashier.updateTotalSubmission((1 * TB) / BYTES_PER_SECTOR - 1);
      let beforeGauge = (await cashier.gauge()).toBigInt();
      await increaseTime(100);
      await cashier.updateGauge();
      let afterGauge = (await cashier.gauge()).toBigInt();
      assert(
        afterGauge - beforeGauge == BigInt(100 * MB),
        "Incorrect gauge delta"
      );
    });

    it("Dynamic dripping rate", async () => {
      await cashier.updateTotalSubmission((1 * TB) / BYTES_PER_SECTOR - 1);
      let beforeGauge = (await cashier.gauge()).toBigInt();
      await increaseTime(100);
      await cashier.updateTotalSubmission((1 * TB) / BYTES_PER_SECTOR);
      await increaseTime(100);
      await cashier.updateGauge();
      let afterGauge = (await cashier.gauge()).toBigInt();
      assert(
        afterGauge - beforeGauge == BigInt(300 * MB),
        "Incorrect gauge delta"
      );
    });

    it("Dripping with purchase", async () => {
      await mockZgsToken.mock.transferFrom.returns(true);

      await cashier.updateTotalSubmission((3 * TB) / BYTES_PER_SECTOR - 1);
      let beforeGauge = (await cashier.gauge()).toBigInt();
      await increaseTime(100);
      await cashier.purchase((50 * MB) / BYTES_PER_SECTOR, BASIC_PRICE, 0);
      await increaseTime(100);
      await cashier.updateGauge();
      let afterGauge = (await cashier.gauge()).toBigInt();
      assert(
        afterGauge - beforeGauge == BigInt(550 * MB),
        "Incorrect gauge delta"
      );
    });
  });

  describe("Test Priority Fee", async () => {
    function assertApproximate(expected: bigint, actual: bigint) {
      const error = expected > actual ? expected - actual : actual - expected;
      const maxError = actual / BigInt(2 ** 32) + BigInt(1);
      assert(error <= maxError);
    }
    const BASE = 900 * MB;
    const MIN_PRICE = BASIC_PRICE / 100;
    const F = (x: number) => 2 ** ((x * GB) / BASE) * BASE * MIN_PRICE;
    const int_f = function (start: number, delta: number) {
      const x = (delta * Math.log(2)) / BASE;
      const k = 2 ** ((start * GB) / BASE);
      return (
        k *
        (x + x ** 2 / 2 + x ** 3 / 6 + x ** 4 / 24 + x ** 5 / 120) *
        BASE *
        MIN_PRICE
      );
    };

    it("Free", async () => {
      await cashier.setGauge(30 * GB);
      const fee = (await cashier.computePriorityFee(20 * GB)).toBigInt();
      assert(fee == BigInt(0), "Incorrect priority fee");
    });

    it("Charged", async () => {
      await cashier.setGauge(-10 * GB);
      const fee = (await cashier.computePriorityFee(1 * GB)).toBigInt();
      const expectedFee = F(11) - F(10);

      assertApproximate(BigInt(Math.floor(expectedFee)), fee);
    });

    it("Partial paid", async () => {
      await cashier.setGauge(30 * GB);
      const fee = (await cashier.computePriorityFee(40 * GB)).toBigInt();
      const expectedFee = F(10) - F(0);

      assertApproximate(BigInt(Math.floor(expectedFee)), fee);
    });

    it("Large purchase", async () => {
      await cashier.setGauge(0);
      const fee = (await cashier.computePriorityFee(100 * GB)).toBigInt();
      const expectedFee = F(100) - F(0);

      assertApproximate(BigInt(Math.floor(expectedFee)), fee);
    });

    it("Large price and small purchase", async () => {
      await cashier.setGauge(-99 * GB);
      const fee = (await cashier.computePriorityFee(256)).toBigInt();
      const expectedFee = int_f(99, 256);

      assertApproximate(BigInt(Math.floor(expectedFee)), fee);
    });

    it("Gauge underflow", async () => {
      await cashier.setGauge(-100 * GB);
      await expect(cashier.computePriorityFee(256)).to.be.revertedWith(
        "Gauge underflow"
      );
    });
  });

  describe("Test Purchase", async () => {
    it("No priority and tip", async () => {
      await cashier.setGauge(20 * GB);
      await mockZgsToken.mock.transferFrom.revertsWithReason(
        "Unexpected args"
      );
      await mockZgsToken.mock.transferFrom
        .withArgs(
          owner.address,
          cashier.address,
          BASIC_PRICE * 10 * BYTES_PER_SECTOR
        )
        .returns(true);

      await cashier.purchase(10, BASIC_PRICE, 0);
      expect(await cashier.paidUploadAmount()).equal(10);
      expect(await cashier.paidFee()).equal(
        BASIC_PRICE * 10 * BYTES_PER_SECTOR
      );
      expect(await cashier.gauge()).equal(20 * GB - 10 * BYTES_PER_SECTOR);
    });

    it("Not paid", async () => {
      await cashier.setGauge(20 * GB);
      await mockZgsToken.mock.transferFrom.revertsWithReason(
        "Unexpected args"
      );
      await mockZgsToken.mock.transferFrom
        .withArgs(
          owner.address,
          cashier.address,
          BASIC_PRICE * 10 * BYTES_PER_SECTOR
        )
        .revertsWithReason("Not allowed");

      await expect(cashier.purchase(10, BASIC_PRICE, 0)).to.be.revertedWith(
        "Not allowed"
      );
    });

    it("Only tip", async () => {
      await cashier.setGauge(20 * GB);
      await mockZgsToken.mock.transferFrom.revertsWithReason(
        "Unexpected args"
      );
      await mockZgsToken.mock.transferFrom
        .withArgs(
          owner.address,
          cashier.address,
          BASIC_PRICE * 20 * BYTES_PER_SECTOR
        )
        .returns(true);

      await cashier.purchase(10, BASIC_PRICE * 2, BASIC_PRICE);
      expect(await cashier.paidUploadAmount()).equal(10);
      expect(await cashier.paidFee()).equal(
        BASIC_PRICE * 20 * BYTES_PER_SECTOR
      );
      expect(await cashier.gauge()).equal(20 * GB - 10 * BYTES_PER_SECTOR);
    });

    it("Capped tip", async () => {
      await cashier.setGauge(20 * GB);
      await mockZgsToken.mock.transferFrom.revertsWithReason(
        "Unexpected args"
      );
      await mockZgsToken.mock.transferFrom
        .withArgs(
          owner.address,
          cashier.address,
          BASIC_PRICE * 20 * BYTES_PER_SECTOR
        )
        .returns(true);

      await cashier.purchase(10, BASIC_PRICE * 2, BASIC_PRICE * 1.5);
      expect(await cashier.paidUploadAmount()).equal(10);
      expect(await cashier.paidFee()).equal(
        BASIC_PRICE * 20 * BYTES_PER_SECTOR
      );
      expect(await cashier.gauge()).equal(20 * GB - 10 * BYTES_PER_SECTOR);
    });

    it("Only priority", async () => {
      await cashier.setGauge(-20 * GB);
      const priorFee = (
        await cashier.computePriorityFee(10 * BYTES_PER_SECTOR)
      ).toBigInt();
      const priorPrice = priorFee / BigInt(10 * BYTES_PER_SECTOR) + BigInt(1);

      await mockZgsToken.mock.transferFrom.revertsWithReason(
        "Unexpected args"
      );
      await mockZgsToken.mock.transferFrom
        .withArgs(
          owner.address,
          cashier.address,
          BASIC_PRICE * 10 * BYTES_PER_SECTOR
        )
        .returns(true);
      await mockZgsToken.mock.transferFrom
        .withArgs(owner.address, mockStake.address, priorFee)
        .returns(true);

      await cashier.purchase(10, BigInt(BASIC_PRICE) + priorPrice, 0);
      expect(await cashier.paidUploadAmount()).equal(10);
      expect(await cashier.paidFee()).equal(
        BASIC_PRICE * 10 * BYTES_PER_SECTOR
      );
      expect(await cashier.gauge()).equal(-20 * GB - 10 * BYTES_PER_SECTOR);
    });

    it("Not enough max fee", async () => {
      await cashier.setGauge(-20 * GB);
      const priorFee = (
        await cashier.computePriorityFee(10 * BYTES_PER_SECTOR)
      ).toBigInt();
      const priorPrice = priorFee / BigInt(10 * BYTES_PER_SECTOR) + BigInt(1);

      await expect(cashier.purchase(10, priorPrice, 0)).to.be.revertedWith(
        "Exceed price limit"
      );
    });

    it("Priority and tip", async () => {
      await cashier.setGauge(-20 * GB);
      const priorFee = (
        await cashier.computePriorityFee(10 * BYTES_PER_SECTOR)
      ).toBigInt();
      const priorPrice = priorFee / BigInt(10 * BYTES_PER_SECTOR) + BigInt(1);

      await mockZgsToken.mock.transferFrom.revertsWithReason(
        "Unexpected args"
      );
      await mockZgsToken.mock.transferFrom
        .withArgs(
          owner.address,
          cashier.address,
          BASIC_PRICE * 20 * BYTES_PER_SECTOR
        )
        .returns(true);
      await mockZgsToken.mock.transferFrom
        .withArgs(owner.address, mockStake.address, priorFee)
        .returns(true);

      await cashier.purchase(
        10,
        BigInt(2) * BigInt(BASIC_PRICE) + priorPrice,
        BASIC_PRICE
      );
      expect(await cashier.paidUploadAmount()).equal(10);
      expect(await cashier.paidFee()).equal(
        BASIC_PRICE * 20 * BYTES_PER_SECTOR
      );
      expect(await cashier.gauge()).equal(-20 * GB - 10 * BYTES_PER_SECTOR);
    });

    it("Priority and capped tip", async () => {
      await cashier.setGauge(-20 * GB);
      const priorFee = (
        await cashier.computePriorityFee(10 * BYTES_PER_SECTOR)
      ).toBigInt();
      const priorPrice = priorFee / BigInt(10 * BYTES_PER_SECTOR) + BigInt(1);

      await mockZgsToken.mock.transferFrom.revertsWithReason(
        "Unexpected args"
      );
      await mockZgsToken.mock.transferFrom
        .withArgs(
          owner.address,
          cashier.address,
          (BigInt(BASIC_PRICE) + priorPrice) * BigInt(10 * BYTES_PER_SECTOR) -
            priorFee
        )
        .returns(true);
      await mockZgsToken.mock.transferFrom
        .withArgs(owner.address, mockStake.address, priorFee)
        .returns(true);

      await cashier.purchase(
        10,
        BigInt(BASIC_PRICE) + priorPrice,
        BigInt(BASIC_PRICE)
      );
      expect(await cashier.paidUploadAmount()).equal(10);
      expect(await cashier.paidFee()).equal(
        (BigInt(BASIC_PRICE) + priorPrice) * BigInt(10 * BYTES_PER_SECTOR) -
          priorFee
      );
      expect(await cashier.gauge()).equal(-20 * GB - 10 * BYTES_PER_SECTOR);
    });
  });

  describe("Test Consume Upload Token", async () => {
    it("Success case", async () => {
      await cashier.setGauge(-20 * GB);

      await mockUploadToken.mock.consume.revertsWithReason("Unexpected args");
      await mockUploadToken.mock.consume
        .withArgs(owner.address, BigInt(10) * UPLOAD_TOKEN_PER_SECTOR)
        .returns();
      await cashier.consumeUploadToken(10);

      expect(await cashier.paidUploadAmount()).equal(10);
      expect(await cashier.paidFee()).equal(
        BASIC_PRICE * 10 * BYTES_PER_SECTOR
      );
      expect(await cashier.gauge()).equal(-20 * GB);
    });

    it("Fail case", async () => {
      await cashier.setGauge(-20 * GB);

      await mockUploadToken.mock.consume.revertsWithReason("Unexpected args");
      await mockUploadToken.mock.consume
        .withArgs(owner.address, BigInt(10) * UPLOAD_TOKEN_PER_SECTOR)
        .revertsWithReason("Cannot consume");
      await expect(cashier.consumeUploadToken(10)).to.revertedWith(
        "Cannot consume"
      );
    });
  });

  describe("Test Charge Fee for Mine", async () => {
    async function topup(sectors: number) {
      await mockUploadToken.mock.consume.returns();
      await cashier.consumeUploadToken(sectors);
    }
    let cashierInternal: CashierTest;
    before(async () => {
      cashierInternal = await cashier.connect(mockFlow);
    });

    it("Permission test", async () => {
      await expect(cashier.chargeFee(7, 8)).to.be.revertedWith(
        "Sender does not have permission"
      );
    });

    it("Update dripping rate", async () => {
      const SECTORS = 1024 * 1024;
      await topup(SECTORS);
      await cashierInternal.chargeFee(SECTORS, SECTORS - 1);
      expect(await cashier.drippingRate()).to.equal(
        (2 * SECTORS * BYTES_PER_SECTOR) / MB
      );
    });

    it("Not paid", async () => {
      await topup(4);
      await expect(cashierInternal.chargeFee(8, 7)).to.be.revertedWith(
        "Data submission is not paid"
      );
    });

    it("Charge partial", async () => {
      await topup(16);
      await cashierInternal.chargeFee(8, 7);
      expect(await cashier.paidFee()).equal(8 * BYTES_PER_SECTOR * BASIC_PRICE);
      expect(await cashier.paidUploadAmount()).equal(8);
    });

    it("Charge in one pricing chunk", async () => {
      await cashier.updateTotalSubmission((2 * GB) / BYTES_PER_SECTOR - 1);
      await topup((8 * GB) / BYTES_PER_SECTOR);
      {
        await cashierInternal.chargeFee((2 * GB) / BYTES_PER_SECTOR, 0);
        const reward = await cashier.rewards(0);
        assert(reward.claimableReward.toNumber() == 0);
        assert(
          reward.lockedReward.toBigInt() == BigInt(2 * GB) * BigInt(BASIC_PRICE)
        );
        assert(reward.timestamp == 0);

        const rewardNext = await cashier.rewards(1);
        assert(rewardNext.lockedReward.toNumber() == 0);
      }

      {
        await cashierInternal.chargeFee((4 * GB) / BYTES_PER_SECTOR, 0);
        const reward = await cashier.rewards(0);
        assert(reward.claimableReward.toNumber() == 0);
        assert(
          reward.lockedReward.toBigInt() == BigInt(6 * GB) * BigInt(BASIC_PRICE)
        );
        assert(reward.timestamp > 0);

        const rewardNext = await cashier.rewards(1);
        assert(rewardNext.lockedReward.toNumber() == 0);
      }

      {
        await cashierInternal.chargeFee((2 * GB) / BYTES_PER_SECTOR, 0);
        const reward = await cashier.rewards(1);
        assert(reward.claimableReward.toNumber() == 0);
        assert(
          reward.lockedReward.toBigInt() == BigInt(2 * GB) * BigInt(BASIC_PRICE)
        );
        assert(reward.timestamp == 0);

        const rewardNext = await cashier.rewards(2);
        assert(rewardNext.lockedReward.toNumber() == 0);
      }
    });

    it("Charge across three pricing chunk", async () => {
      await cashier.updateTotalSubmission((2 * GB) / BYTES_PER_SECTOR - 1);
      await topup((16 * GB) / BYTES_PER_SECTOR);
      {
        await cashierInternal.chargeFee((16 * GB) / BYTES_PER_SECTOR, 0);
        const reward0 = await cashier.rewards(0);
        assert(reward0.claimableReward.toNumber() == 0);
        assert(
          reward0.lockedReward.toBigInt() ==
            BigInt(6 * GB) * BigInt(BASIC_PRICE)
        );
        assert(reward0.timestamp > 0);

        const reward1 = await cashier.rewards(1);
        assert(reward1.claimableReward.toNumber() == 0);
        assert(
          reward1.lockedReward.toBigInt() ==
            BigInt(8 * GB) * BigInt(BASIC_PRICE)
        );
        assert(reward1.timestamp > 0);

        const reward2 = await cashier.rewards(2);
        assert(reward2.claimableReward.toNumber() == 0);
        assert(
          reward2.lockedReward.toBigInt() ==
            BigInt(2 * GB) * BigInt(BASIC_PRICE)
        );
        assert(reward2.timestamp == 0);

        const rewardNext = await cashier.rewards(3);
        assert(rewardNext.lockedReward.toNumber() == 0);
      }
    });

    describe("Test Claim Reward for Mine", async () => {
      async function imposeReward(finalized: boolean) {
        await cashier.updateTotalSubmission((2 * GB) / BYTES_PER_SECTOR - 1);
        await mockUploadToken.mock.consume.returns();
        await cashier.consumeUploadToken((6 * GB) / BYTES_PER_SECTOR);
        if (finalized) {
          await cashier
            .connect(mockFlow)
            .chargeFee((6 * GB) / BYTES_PER_SECTOR, 0);
        } else {
          await cashier
            .connect(mockFlow)
            .chargeFee((5 * GB) / BYTES_PER_SECTOR, 0);
        }
      }
      let cashierInternal: CashierTest;
      before(async () => {
        cashierInternal = await cashier.connect(mockMine);
      });

      it("Permission test", async () => {
        await expect(
          cashier.claimMineReward(0, owner.address)
        ).to.be.revertedWith("Sender does not have permission");
      });
    });
  });
});
